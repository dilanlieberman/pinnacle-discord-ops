#!/usr/bin/env node
/**
 * announce-whop-payment.js
 *
 * Manually announce a single Whop payment to the Discord wins channel.
 * Used to recover payments that the watcher dropped due to transient failures
 * (e.g., the bot lacked Send Messages perms when the payment came in and the
 * old watcher code marked it seen anyway).
 *
 * Usage:
 *   node scripts/announce-whop-payment.js <payment_id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { paymentAmount } = require('./lib/whop-watcher');
const { formatWinMessage } = require('./lib/win-message');

const { WHOP_API_KEY, DISCORD_BOT_TOKEN, DISCORD_WINS_CHANNEL_ID } = process.env;
const WINS_CHANNEL_ID = DISCORD_WINS_CHANNEL_ID || '1453552314953764881';

async function fetchPayment(id) {
  const res = await fetch(`https://api.whop.com/v2/payments/${id}`, {
    headers: { Authorization: `Bearer ${WHOP_API_KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`whop http ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function postToDiscord(channelId, content) {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`discord http ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  const paymentId = process.argv[2];
  if (!paymentId) {
    console.error('usage: node scripts/announce-whop-payment.js <payment_id>');
    process.exit(1);
  }
  if (!WHOP_API_KEY) throw new Error('WHOP_API_KEY not set');
  if (!DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not set');

  const p = await fetchPayment(paymentId);
  if (p.status !== 'paid') {
    console.warn(`payment ${paymentId} status is "${p.status}", not "paid" — proceeding anyway`);
  }
  const amount = paymentAmount(p);
  const message = formatWinMessage(amount);

  console.log(`posting to channel ${WINS_CHANNEL_ID}:\n${message}\n`);
  await postToDiscord(WINS_CHANNEL_ID, message);
  console.log(`announced ${paymentId} ($${amount})`);
}

main().catch(err => {
  console.error(`failed: ${err.message}`);
  process.exit(1);
});
