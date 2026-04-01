/**
 * pipeline-monitor.js
 *
 * Express webhook server that receives GHL pipeline stage-change events
 * and pings the correct setter in their individual Discord channel.
 *
 * Usage:
 *   node scripts/pipeline-monitor.js
 *
 * Required .env vars:
 *   DISCORD_BOT_TOKEN, GHL_WEBHOOK_SECRET
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ─── Dependencies ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');

// ─── Env Validation ───────────────────────────────────────────────────────────

const { DISCORD_BOT_TOKEN, GHL_WEBHOOK_SECRET } = process.env;

if (!DISCORD_BOT_TOKEN) {
  console.error('[pipeline-monitor] Missing required env var: DISCORD_BOT_TOKEN');
  process.exit(1);
}

if (!GHL_WEBHOOK_SECRET) {
  console.error('[pipeline-monitor] Missing required env var: GHL_WEBHOOK_SECRET');
  process.exit(1);
}

// ─── PID Lock ─────────────────────────────────────────────────────────────────

const PID_FILE = path.join(__dirname, '../.pipeline-monitor.pid');

if (fs.existsSync(PID_FILE)) {
  const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  try {
    process.kill(existingPid, 0);
    console.error(`[pipeline-monitor] Already running (PID ${existingPid}). Exiting to prevent duplicates.`);
    process.exit(1);
  } catch {
    console.log(`[pipeline-monitor] Removing stale PID file (PID ${existingPid} is gone).`);
  }
}

fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

// ─── User Map ─────────────────────────────────────────────────────────────────

// Maps lowercase setter name → { userId, channelId }
const USER_MAP = {
  cole:   { userId: '1477065877118521497', channelId: '1488768699589460028' },
  dilan:  { userId: '947568555560423474',  channelId: '1488768756472746127' },
  martin: { userId: '855489254662602783',  channelId: '1488768804527013928' },
  boeh:   { userId: '1428992875571707957', channelId: '1488768952115925102' },
  sofie:  { userId: '1179969471016865795', channelId: '1488768785874686092' },
  omar:   { userId: '641462743215636520',  channelId: '1488768918331068437' },
  cesar:  { userId: '757770256398811287',  channelId: '1488768733689286727' },
};

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Auth middleware: validate the shared webhook secret header
app.use('/webhook/ghl', (req, res, next) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== GHL_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// POST /webhook/ghl — handle pipeline stage-change events from GHL
app.post('/webhook/ghl', (req, res) => {
  // Respond 200 immediately so GHL doesn't retry
  res.status(200).json({ ok: true });

  // GHL nests custom data fields under req.body.customData
  const data = req.body.customData || {};
  const setterName  = data['Setter Name'];
  const contactName = data['Name'];
  const followUpDay = data['Follow up day'];
  const phone       = data['Phone'];

  if (!setterName) {
    console.warn('[pipeline-monitor] Webhook payload missing "Setter Name" in customData — skipping');
    return;
  }

  if (!contactName || !followUpDay) {
    console.warn('[pipeline-monitor] Webhook payload missing "Name" or "Follow up day" in customData — skipping');
    return;
  }

  const key = setterName.toLowerCase().trim();
  const user = USER_MAP[key];

  if (!user) {
    console.warn(`[pipeline-monitor] Unknown setter "${setterName}" (key: "${key}") — not in USER_MAP`);
    return;
  }

  let message = `<@${user.userId}> Call ${contactName} for your ${followUpDay} followup.`;
  if (phone) message += ` His phone number is ${phone}`;

  sendDiscordMessage(user.channelId, message).catch((err) => {
    console.error(`[pipeline-monitor] Failed to send Discord message for setter "${setterName}":`, err.message);
  });
});

// ─── Discord Client ───────────────────────────────────────────────────────────

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds], // only need to fetch channels and post
});

/**
 * Fetch a Discord channel by ID and send a message.
 */
async function sendDiscordMessage(channelId, message) {
  const channel = await discordClient.channels.fetch(channelId);
  if (!channel) throw new Error(`Channel ${channelId} not found or bot lacks access`);
  await channel.send(message);
}

// Log Discord errors without crashing
discordClient.on('error', (err) => {
  console.error('[pipeline-monitor] Discord client error:', err.message);
});

discordClient.on('warn', (info) => {
  console.warn('[pipeline-monitor] Discord warning:', info);
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PIPELINE_PORT || 3001;

// Start Express only after Discord is ready
discordClient.once('ready', () => {
  console.log(`[pipeline-monitor] Discord bot ready as ${discordClient.user.tag}`);

  app.listen(PORT, () => {
    console.log(`[pipeline-monitor] Webhook server listening on port ${PORT}`);
  });
});

discordClient.login(DISCORD_BOT_TOKEN).catch((err) => {
  console.error('[pipeline-monitor] Failed to log in to Discord:', err.message);
  process.exit(1);
});
