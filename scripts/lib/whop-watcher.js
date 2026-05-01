/**
 * whop-watcher.js
 *
 * Polls Whop's /v2/payments endpoint, fires `onNewPayment(payment)` for each
 * paid payment that hasn't been announced yet, and persists state so we don't
 * re-announce on bot restart.
 *
 * On first run (no state file), all currently-paid payments are marked as
 * "already seen" so we don't spam the channel with historical backlog.
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.whop.com/v2';
const PER_PAGE = 50;
const MAX_SEEN_IDS = 500; // bound the state file

async function fetchAllPayments(apiKey) {
  const out = [];
  let page = 1;
  while (true) {
    const url = `${API_BASE}/payments?per=${PER_PAGE}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`whop http ${res.status}: ${body.slice(0, 300)}`);
    }
    const body = await res.json();
    const rows = body.data || [];
    out.push(...rows);
    const totalPages = Number(body.pagination?.total_page || 0);
    if (page >= totalPages || rows.length === 0) break;
    page += 1;
  }
  return out;
}

function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  // Cap seenIds to most-recent N to keep file small
  const trimmed = {
    ...state,
    seenIds: state.seenIds.slice(-MAX_SEEN_IDS),
  };
  fs.writeFileSync(statePath, JSON.stringify(trimmed, null, 2));
}

function paymentAmount(p) {
  // Match whop-sync.py: prefer final_amount, fallback to total
  const v = p.final_amount ?? p.total ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Start the watcher. Returns a `stop()` function.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey            - Whop API key
 * @param {string} opts.statePath         - absolute path to state JSON file
 * @param {(p: object) => Promise<void>} opts.onNewPayment - called for each new paid payment
 * @param {number} [opts.intervalMs=60000]
 * @param {(level: 'info'|'warn'|'error', msg: string) => void} [opts.log]
 */
function startWhopWatcher({ apiKey, statePath, onNewPayment, intervalMs = 60_000, log }) {
  const logger = log || ((lvl, msg) => console[lvl === 'error' ? 'error' : 'log'](`[whop-watcher] ${msg}`));

  let state = loadState(statePath);
  let bootstrap = false;
  if (!state) {
    bootstrap = true;
    state = { lastSeenCreatedAt: 0, seenIds: [] };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      const payments = await fetchAllPayments(apiKey);
      const paid = payments.filter(p => p.status === 'paid');

      if (bootstrap) {
        // First run — mark everything currently paid as seen, don't notify.
        const maxCreated = paid.reduce((m, p) => Math.max(m, Number(p.created_at) || 0), 0);
        state = {
          lastSeenCreatedAt: maxCreated || Math.floor(Date.now() / 1000),
          seenIds: paid.map(p => p.id),
        };
        saveState(statePath, state);
        bootstrap = false;
        logger('info', `bootstrap: marked ${paid.length} existing paid payments as seen`);
        return;
      }

      const seenSet = new Set(state.seenIds);
      // Sort oldest-first so notifications post in chronological order
      const newPaid = paid
        .filter(p => !seenSet.has(p.id))
        .filter(p => Number(p.created_at || 0) > state.lastSeenCreatedAt)
        .sort((a, b) => Number(a.created_at) - Number(b.created_at));

      if (newPaid.length === 0) return;

      logger('info', `found ${newPaid.length} new paid payment(s)`);
      for (const p of newPaid) {
        // Mark as seen BEFORE announcing + persist immediately. This way, if
        // the process dies between the Discord post and the state-save (e.g.
        // PM2 restart mid-deploy), the next instance won't re-announce.
        // Tradeoff: if the announce itself fails AND the failure-cleanup
        // write below also fails, one announcement is lost. Acceptable for a
        // celebratory channel where duplicate spam is worse than rare loss.
        state.seenIds.push(p.id);
        const created = Number(p.created_at) || 0;
        const prevLastSeen = state.lastSeenCreatedAt;
        if (created > state.lastSeenCreatedAt) state.lastSeenCreatedAt = created;
        saveState(statePath, state);

        try {
          await onNewPayment(p);
        } catch (err) {
          // Roll back the seen-marking so the next poll retries. A transient
          // failure (perm error, Discord outage, rate limit) shouldn't silently
          // drop the payment.
          state.seenIds.pop();
          state.lastSeenCreatedAt = prevLastSeen;
          saveState(statePath, state);
          logger('error', `onNewPayment failed for ${p.id}: ${err.message} — will retry next poll`);
          continue;
        }
      }
    } catch (err) {
      logger('error', `poll failed: ${err.message}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  // Kick off first poll on next tick so caller can finish setup
  timer = setTimeout(tick, 0);

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = { startWhopWatcher, paymentAmount };
