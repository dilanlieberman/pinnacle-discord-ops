/**
 * discord-bot.js
 *
 * Listens for lead upload instructions in a specific Discord channel
 * and spawns ghl-lead-uploader.js as a child process.
 *
 * Usage:
 *   node scripts/discord-bot.js
 *
 * Required .env vars:
 *   DISCORD_BOT_TOKEN, DISCORD_OWNER_ID
 *   DISCORD_LEADS_CHANNEL_ID    — channel that accepts upload commands
 *   DISCORD_ONBOARD_CHANNEL_ID  — channel that accepts `onboard <name>`
 *   (legacy DISCORD_CHANNEL_ID is still honored as a fallback for both)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ─── Dependencies & Config ────────────────────────────────────────────────────

const { Client, GatewayIntentBits } = require('discord.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { startWhopWatcher, paymentAmount } = require('./lib/whop-watcher');
const { formatWinMessage } = require('./lib/win-message');
const dryTest = require('./lib/dry-test-handler');

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,            // legacy single-channel var
  DISCORD_LEADS_CHANNEL_ID,
  DISCORD_ONBOARD_CHANNEL_ID,
  DISCORD_DRY_TEST_CHANNEL_ID,
  DISCORD_WINS_CHANNEL_ID,
  DISCORD_OWNER_ID,
  DISCORD_ALLOWED_USERS,
  WHOP_API_KEY,
} = process.env;

// Wins channel — defaults to the Pinnacle wins channel if not overridden
const WINS_CHANNEL_ID = DISCORD_WINS_CHANNEL_ID || '1453552314953764881';

// Back-compat: fall back to legacy DISCORD_CHANNEL_ID for either role if specific one isn't set
const LEADS_CHANNEL_ID   = DISCORD_LEADS_CHANNEL_ID   || DISCORD_CHANNEL_ID;
const ONBOARD_CHANNEL_ID = DISCORD_ONBOARD_CHANNEL_ID || DISCORD_CHANNEL_ID;

const DRY_TEST_ONLY = process.env.DRY_TEST_ONLY === 'true';
const DRY_TEST_CHANNEL_ID = DISCORD_DRY_TEST_CHANNEL_ID || '';

if (!DISCORD_BOT_TOKEN || !DISCORD_OWNER_ID) {
  console.error('Missing required env vars: DISCORD_BOT_TOKEN, DISCORD_OWNER_ID');
  process.exit(1);
}
if (DRY_TEST_ONLY) {
  if (!DRY_TEST_CHANNEL_ID) {
    console.error('DRY_TEST_ONLY=true but DISCORD_DRY_TEST_CHANNEL_ID is not set');
    process.exit(1);
  }
} else {
  if (!LEADS_CHANNEL_ID && !ONBOARD_CHANNEL_ID) {
    console.error('Missing required env vars: at least one of DISCORD_LEADS_CHANNEL_ID / DISCORD_ONBOARD_CHANNEL_ID');
    process.exit(1);
  }
}

// Build the allowed user set: always includes owner, plus any extras from DISCORD_ALLOWED_USERS
const ALLOWED_USER_IDS = new Set([
  DISCORD_OWNER_ID,
  ...(DISCORD_ALLOWED_USERS ? DISCORD_ALLOWED_USERS.split(',').map(id => id.trim()) : []),
]);

// ─── Single-Instance Lock ─────────────────────────────────────────────────────

const PID_FILE = path.join(__dirname, '../.bot.pid');

// If a PID file exists and that process is still alive, refuse to start
if (fs.existsSync(PID_FILE)) {
  const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  try {
    process.kill(existingPid, 0); // signal 0 = just check if process exists
    console.error(`Bot is already running (PID ${existingPid}). Exiting to prevent duplicates.`);
    process.exit(1);
  } catch {
    // Process is dead — stale PID file, safe to continue
    console.log(`Removing stale PID file (PID ${existingPid} is gone).`);
  }
}

fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

// ─── Constants ────────────────────────────────────────────────────────────────

const LEADS_DIR     = path.join(__dirname, '../data/leads/all_contacts_final');
const TRACKING_FILE = path.join(__dirname, '../data/leads/tracking.json');
const LOGS_DIR      = path.join(__dirname, '../data/logs');

const VALID_SERVICES = ['remodelers', 'roofing', 'landscaping', 'pools_and_patios', 'fencing', 'misc'];

// Shortage replies expire after 5 minutes if the owner doesn't respond
const SHORTAGE_TTL_MS = 5 * 60 * 1000;

// ─── State Maps ───────────────────────────────────────────────────────────────

// Full state names (lowercase) → 2-letter abbreviation
const STATE_ABBREVS = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC',
};

const VALID_STATE_ABBREVS = new Set(Object.values(STATE_ABBREVS));

// Build a regex that matches full state names, longest first (prevents "New" matching before "New York")
const STATE_NAME_RE = new RegExp(
  '\\b(' + Object.keys(STATE_ABBREVS).sort((a, b) => b.length - a.length).join('|') + ')\\b',
  'i'
);

// In-memory map of pending shortage decisions: userId → { params, available, expiresAt }
const pendingShortages = new Map();

// In-memory map of pending onboard asset uploads: userId → { clientSlug, expiresAt }
const pendingOnboards = new Map();

// In-memory map of pending 'continue' resolvers for the orchestrator pause points
const pendingContinues = new Map();

// Global upload mutex — only one upload can run at a time per bot instance.
// Prevents two simultaneous commands from racing on the same (or overlapping)
// row ranges, which is what caused the 504/496 duplicate split earlier today.
// Shape: { userId, params, startedAt } or null.
let currentUpload = null;

// Per-user recent-command cache for debouncing identical back-to-back uploads.
// Blocks the exact same command (same service+state+count+account+workflow)
// from the same user within DEBOUNCE_MS — defends against accidental double-taps
// and Discord retries.
const recentCommands = new Map(); // userId → { hash, timestamp }
const DEBOUNCE_MS = 60_000;

function commandHash(params) {
  return `${params.service}|${params.state}|${params.count}|${params.account.toLowerCase()}|${params.workflow.toLowerCase()}`;
}

// ─── Message Parsing ──────────────────────────────────────────────────────────

/**
 * Parse a natural language upload command into its 5 required parameters.
 * Returns { success: true, params } or { success: false, missing: [...] }.
 *
 * Handles examples like:
 *   "Upload 1500 AL remodelers into coleton sub acc 1 and trigger boom1"
 *   "Send 500 Florida roofing leads to cesar sub acc 1 workflow follow-up"
 *   "Import 2000 CA landscaping into dilan sub acc 1 boom1"
 *   "Upload 1000 TX fencing to tony sub acc 1 and trigger sms-blast"
 */
function parseUploadCommand(rawText) {
  // Normalize whitespace; treat "pools and patios" as the underscore form
  const text = rawText.replace(/\s+/g, ' ').trim()
    .replace(/pools\s+and\s+patios/gi, 'pools_and_patios');

  const missing = [];

  // SERVICE — match one of the 6 known values
  const serviceMatch = text.match(/\b(remodelers|roofing|landscaping|pools_and_patios|fencing|misc)\b/i);
  const service = serviceMatch ? serviceMatch[1].toLowerCase() : null;
  if (!service) missing.push('service');

  // STATE — try full name first, then 2-letter abbreviation
  let state = null;
  const stateNameMatch = text.match(STATE_NAME_RE);
  if (stateNameMatch) {
    state = STATE_ABBREVS[stateNameMatch[1].toLowerCase()];
  } else {
    // Only look for 2-letter abbreviations in the segment before "into"/"to"
    // to avoid matching abbreviations embedded in account names
    const beforeKeyword = text.split(/\s+(?:into|to)\s+/i)[0];
    const abbrevMatch = beforeKeyword.match(/\b([A-Z]{2})\b/);
    if (abbrevMatch && VALID_STATE_ABBREVS.has(abbrevMatch[1].toUpperCase())) {
      state = abbrevMatch[1].toUpperCase();
    }
  }
  if (!state) missing.push('state');

  // COUNT — an integer in the segment before "into"/"to"
  const beforeKeyword = text.split(/\s+(?:into|to)\s+/i)[0];
  const countMatch = beforeKeyword.match(/\b(\d{1,6})\b/);
  const count = countMatch ? parseInt(countMatch[1], 10) : null;
  if (!count || count <= 0) missing.push('count');

  // ACCOUNT + WORKFLOW — parsed together from the "into/to ... [trigger|workflow] ..." portion
  let account = null;
  let workflow = null;

  // Primary: "into/to <account> [and] trigger/workflow <workflow>"
  const primaryAccountMatch = text.match(/(?:into|to)\s+(.+?)\s+(?:and\s+)?(?:trigger|workflow)\s+/i);
  if (primaryAccountMatch) {
    account = primaryAccountMatch[1].trim();
    // Workflow is everything after the last trigger/workflow keyword
    const workflowMatch = text.match(/(?:trigger|workflow)\s+(\S+(?:\s+\S+)*)\s*$/i);
    workflow = workflowMatch ? workflowMatch[1].trim() : null;
  } else {
    // Fallback: no trigger/workflow keyword — last token is workflow, rest is account
    // e.g. "Import 2000 CA landscaping into dilan sub acc 1 boom1"
    const fallbackMatch = text.match(/(?:into|to)\s+(.+)\s+(\S+)$/i);
    if (fallbackMatch) {
      account = fallbackMatch[1].trim();
      workflow = fallbackMatch[2].trim();
    }
  }

  if (!account) missing.push('account');
  if (!workflow) missing.push('workflow');

  if (missing.length > 0) {
    return { success: false, missing };
  }

  return { success: true, params: { service, state, count, account, workflow } };
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate parsed params.
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateParams(params) {
  if (!VALID_SERVICES.includes(params.service)) {
    return { valid: false, error: `Unknown service "${params.service}". Valid: ${VALID_SERVICES.join(', ')}` };
  }

  const csvPath = path.join(LEADS_DIR, params.service, `${params.state}.csv`);
  if (!fs.existsSync(csvPath)) {
    return { valid: false, error: `No CSV found for ${params.state} ${params.service}. Check data/leads/all_contacts_final/${params.service}/` };
  }

  return { valid: true };
}

// ─── Shortage Handling ────────────────────────────────────────────────────────

/**
 * Check if enough unused leads are available for the requested upload.
 * Must be called BEFORE spawning the uploader to avoid the stdin prompt deadlock.
 */
function checkShortage(params) {
  const tracking = fs.existsSync(TRACKING_FILE)
    ? JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'))
    : {};

  const key = `${params.service}/${params.state}`;
  const usedRows = tracking[key]?.usedRows ?? 0;

  const csvPath = path.join(LEADS_DIR, params.service, `${params.state}.csv`);
  const rows = parse(fs.readFileSync(csvPath, 'utf8'), {
    columns: true, skip_empty_lines: true, trim: true,
  });

  const available = rows.length - usedRows;
  return { shortage: available < params.count, available };
}

/**
 * Build the full CLI command string for a set of params.
 * Used when telling the user how to run two separate uploads for option 2.
 */
function buildCommandString(params) {
  return `node scripts/ghl-lead-uploader.js --service ${params.service} --state ${params.state} --count ${params.count} --account "${params.account}" --workflow "${params.workflow}"`;
}

/**
 * Handle a shortage reply from the owner.
 * Expects either "1" (upload only what's available) or "2 <state>" (fill from another state).
 */
async function handleShortageReply(message, pendingState) {
  const text = message.content.trim();
  const { params, available } = pendingState;

  if (text === '1') {
    pendingShortages.delete(message.author.id);
    const adjustedParams = { ...params, count: available };
    await runUpload(message, adjustedParams);
    return;
  }

  // Match option 2 loosely — accepts anything that starts with "2" followed
  // by a state hint, in any form the user might type:
  //   "2 GA"
  //   "2 Nevada"
  //   "2 NV — upload 628 from UT and fill the remaining 372 from another state"
  //   "2 New York fill the rest"
  //   "2nv"
  // Strategy: require a leading "2", then reuse the main command parser's
  // state-name regex + 2-letter-abbrev fallback on the remainder.
  const option2Lead = text.match(/^\s*2[\s,:.\-]*(.*)$/);
  if (option2Lead) {
    const after = option2Lead[1];
    let fillState = null;

    // 1) Full state name ("Nevada", "New York") — longest-first regex
    const nameMatch = after.match(STATE_NAME_RE);
    if (nameMatch) {
      fillState = STATE_ABBREVS[nameMatch[1].toLowerCase()];
    }
    // 2) Fall back to first uppercase 2-letter token ("NV", "GA")
    if (!fillState) {
      const abbrevMatch = after.match(/\b([A-Za-z]{2})\b/);
      if (abbrevMatch && VALID_STATE_ABBREVS.has(abbrevMatch[1].toUpperCase())) {
        fillState = abbrevMatch[1].toUpperCase();
      }
    }

    if (!fillState) {
      await message.reply(
        `Could not find a state in your reply. Try \`2 NV\` or \`2 Nevada\` — just the number \`2\` and the state.`
      );
      return;
    }

    pendingShortages.delete(message.author.id);

    const needed = params.count - available;
    const primaryParams   = { ...params, count: available };
    const secondaryParams = { ...params, state: fillState, count: needed };

    // Validate the secondary state has a CSV and enough unused leads BEFORE
    // starting anything — better to fail fast than to run the primary upload
    // and then discover we can't complete the fill.
    const secondaryValidation = validateParams(secondaryParams);
    if (!secondaryValidation.valid) {
      await message.reply(`Can't fill from ${fillState}: ${secondaryValidation.error}`);
      return;
    }
    let secondaryCheck;
    try {
      secondaryCheck = checkShortage(secondaryParams);
    } catch (err) {
      await message.reply(`Error checking ${fillState} availability: ${err.message}`);
      return;
    }
    if (secondaryCheck.shortage) {
      await message.reply(
        `Can't fill from ${fillState}: only **${secondaryCheck.available}** unused ` +
        `${fillState} ${params.service} leads available, need **${needed}**. ` +
        `Try a different state.`
      );
      return;
    }

    await message.reply(
      `Running 2 uploads back-to-back:\n` +
      `**1.** ${available} ${params.state} → ${params.account} (${params.workflow})\n` +
      `**2.** ${needed} ${fillState} → ${params.account} (${params.workflow})`
    );

    // Run sequentially. runUpload sets/clears the global currentUpload mutex
    // internally, so by the time the first await returns the mutex is free
    // and the second call can acquire it cleanly. The two commands have
    // different state values, so the per-user debounce also doesn't block
    // the second one.
    await runUpload(message, primaryParams).catch(console.error);
    await runUpload(message, secondaryParams).catch(console.error);
    return;
  }

  // Invalid — re-prompt without clearing pending state
  await message.reply(
    'Invalid response. Reply with:\n' +
    '• `1` — upload only what\'s available\n' +
    '• `2 GA` — fill the remainder from another state (replace GA with your chosen state)'
  );
}

// ─── Upload Execution ─────────────────────────────────────────────────────────

/** Format seconds as "Xm Ys" or just "Ys" */
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Read the most recently modified upload log from data/logs/, but only if it
 * was written AFTER `sinceMs`. This prevents reporting a stale log from a
 * previous upload when the current child exited before writing one (e.g. it
 * silently bailed on an interactive prompt under stdin=/dev/null).
 *
 * Returns the log object, or null if no fresh log exists.
 */
function readFreshLog(sinceMs) {
  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.startsWith('upload-') && f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(LOGS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return null;
  if (files[0].mtime < sinceMs) return null;

  return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, files[0].name), 'utf8'));
}

/**
 * Spawn ghl-lead-uploader.js as a child process and report results to Discord.
 *
 * Guarded by the global `currentUpload` mutex to ensure only ONE uploader child
 * runs per bot instance at a time. The caller in messageCreate is responsible
 * for refusing new work while `currentUpload` is non-null; this function still
 * sets/clears it defensively so callers can't forget.
 */
async function runUpload(message, params) {
  // Defensive: if somehow another upload is already running, refuse rather
  // than racing. The messageCreate handler should have caught this, but
  // handleShortageReply also routes here and we want one choke point.
  if (currentUpload) {
    await message.reply(
      `Refusing to start: another upload is already in progress. This shouldn't happen — please report it.`
    );
    return;
  }

  currentUpload = { userId: message.author.id, params, startedAt: Date.now() };
  // Record for debouncing — any identical command within DEBOUNCE_MS will be ignored
  recentCommands.set(message.author.id, { hash: commandHash(params), timestamp: Date.now() });

  await message.reply(
    `Starting upload: ${params.count} ${params.state} ${params.service} leads → ${params.account} → workflow: ${params.workflow}`
  );

  const args = [
    'scripts/ghl-lead-uploader.js',
    '--service',  params.service,
    '--state',    params.state,
    '--count',    String(params.count),
    '--account',  params.account,
    '--workflow', params.workflow,
  ];

  // Capture spawn time so we can reject any stale log file from a previous run.
  // Subtract 1s to absorb clock skew between this process and the child's
  // log-write fs call.
  const spawnTime = Date.now() - 1000;

  const child = spawn('node', args, {
    cwd: path.join(__dirname, '..'),  // project root — required for relative paths in the uploader
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,  // pass already-loaded .env vars to the child
  });

  let stderrBuffer = '';
  child.stderr.on('data', (chunk) => { stderrBuffer += chunk.toString(); });

  // Log child stdout to console for visibility without posting to Discord mid-run
  child.stdout.on('data', (chunk) => { process.stdout.write(chunk); });

  await new Promise((resolve) => {
    // Helper so every exit path releases the mutex, no matter what
    const release = () => { currentUpload = null; resolve(); };

    child.on('error', async (err) => {
      await message.reply(`Failed to start upload process: ${err.message}`).catch(console.error);
      release();
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        const errMsg = stderrBuffer.trim().slice(0, 1800) || `Process exited with code ${code}`;
        await message.reply(`Upload failed (exit code ${code}):\n\`\`\`\n${errMsg}\n\`\`\``).catch(console.error);
        release();
        return;
      }

      // Exit code 0 — but we still need to verify a NEW log file was actually
      // written. If the script exited cleanly without writing a log, it almost
      // certainly hit an interactive prompt (stdin=/dev/null hangs readline,
      // then Node exits 0 with no pending work). In that case, surface stderr
      // so the user can see what went wrong instead of reading a stale log.
      try {
        const logData = readFreshLog(spawnTime);
        if (!logData) {
          const errMsg = stderrBuffer.trim().slice(0, 1800) ||
            '(no stderr captured — script likely hit an interactive prompt)';
          await message.reply(
            `Upload finished with exit code 0 but produced **no log file** — the ` +
            `script likely hit an interactive prompt or exited early. No leads ` +
            `were uploaded. Stderr:\n\`\`\`\n${errMsg}\n\`\`\``
          ).catch(console.error);
          release();
          return;
        }
        const s = logData.summary;
        // New summary fields (requested/processed/cursorAdvanced/invariantOk)
        // are present on logs from the patched script. Fall back gracefully
        // for any older log just in case.
        const requested = s.requested ?? s.processed ?? (s.uploaded + s.skipped + s.failed);
        const processed = s.processed ?? (s.uploaded + s.skipped + s.failed);
        const advanced  = s.cursorAdvanced ?? processed;
        const invariantOk = s.invariantOk !== false;

        let reply =
          `**Done!** Requested: ${requested} | Processed: ${processed} | ` +
          `New: ${s.uploaded} | Already in GHL: ${s.skipped} | Failed: ${s.failed} | ` +
          `Time: ${formatDuration(s.durationSeconds)}`;

        if (!invariantOk || advanced !== processed || processed !== requested) {
          reply += `\n⚠️ **Invariant warning:** cursor advanced by ${advanced} but ` +
            `${processed} rows were processed against a request of ${requested}. ` +
            `Tracking may be off — DO NOT run another upload from this state until verified.`;
        }
        if (s.failed > 0) {
          reply += `\n⚠️ ${s.failed} row(s) failed permanently — see the log file for recovery: \`data/logs/\``;
        }

        await message.reply(reply);

        // Sync lead inventory to Supabase after successful upload
        try {
          const { execFile } = require('child_process');
          execFile('node', [require('path').join(__dirname, 'agency-tracker/lead-inventory-sync.js')], { timeout: 30000 }, (err, stdout) => {
            if (err) console.error('[lead-inventory] post-upload sync failed:', err.message);
            else console.log('[lead-inventory] post-upload sync done');
          });
        } catch (syncErr) {
          console.error('[lead-inventory] sync trigger failed:', syncErr.message);
        }
      } catch (logErr) {
        await message.reply(`Upload completed but couldn't read log file: ${logErr.message}`).catch(console.error);
      }

      release();
    });
  });
}

// ─── Dry-test config ─────────────────────────────────────────────────────────

// Hardcoded GHL sub-account used for `onboard <source> dry test` runs. Phase 2
// creates a private-integration token for it during the run, so no manual
// token setup is needed.
const DRY_TEST_LOCATION_ID = 'PqU9qEIKN9ov4Nx8dsx6';
const DRY_TEST_SLUG = 'dry-test';

// ─── Onboard Pipeline ────────────────────────────────────────────────────────

/**
 * Save image attachments from a Discord message into a client's assets dir.
 * Naming rules:
 *   - filename contains "logo" → saved as logo.{ext}
 *   - first non-logo image → selfie-1.{ext}
 *   - second non-logo image → selfie-2.{ext}
 *   - additional non-logo images are ignored
 * Skips non-image attachments. Returns array of saved filenames.
 */
async function saveOnboardAttachments(attachments, assetsDir) {
  const saved = [];
  let selfieIdx = 0;
  for (const att of attachments.values()) {
    const isImage = (att.contentType && att.contentType.startsWith('image/'))
      || /\.(jpg|jpeg|png|webp)$/i.test(att.name || '');
    if (!isImage) continue;
    const rawExt = (path.extname(att.name || '').slice(1).toLowerCase()) || 'jpg';
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
    let targetName;
    if (/logo/i.test(att.name || '')) {
      targetName = `logo.${ext}`;
    } else if (selfieIdx < 2) {
      selfieIdx++;
      targetName = `selfie-${selfieIdx}.${ext}`;
    } else {
      continue; // ignore extras
    }
    try {
      const resp = await fetch(att.url);
      if (!resp.ok) {
        console.error(`Attachment fetch ${att.name} → HTTP ${resp.status}`);
        continue;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(path.join(assetsDir, targetName), buf);
      saved.push(targetName);
    } catch (err) {
      console.error(`Failed saving attachment ${att.name}:`, err.message);
    }
  }
  // Always (re)alias selfie-1 → selfie.{matching-ext} so Phase 9 (which reads
  // selfie.{ext}) gets the freshly-uploaded file. Clear stale selfie.* of
  // OTHER extensions to prevent old aliases from blocking the new run.
  const exts = ['jpg', 'jpeg', 'png', 'webp'];
  const selfie1 = exts.map(e => path.join(assetsDir, `selfie-1.${e}`)).find(p => fs.existsSync(p));
  if (selfie1) {
    const srcExt = path.extname(selfie1);
    for (const ext of exts) {
      const stale = path.join(assetsDir, `selfie.${ext}`);
      if (fs.existsSync(stale) && stale !== path.join(assetsDir, `selfie${srcExt}`)) {
        fs.unlinkSync(stale);
      }
    }
    fs.copyFileSync(selfie1, path.join(assetsDir, `selfie${srcExt}`));
  }
  return saved;
}

async function runOnboardPipeline(message, clientSlug) {
  const { runFullPipeline } = require('./service-delivery/orchestrator');

  const userId = message.author.id;

  const waitForContinue = () => new Promise(resolve => {
    pendingContinues.set(userId, resolve);
  });

  try {
    await runFullPipeline(clientSlug, {
      notify: msg => message.channel.send(msg),
      waitForContinue,
    });
  } catch (err) {
    await message.channel.send(`❌ Pipeline failed at: ${err.message}`);
  } finally {
    pendingContinues.delete(userId);
  }
}

// ─── Event Handlers & Startup ─────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // required to read message text
  ],
});

client.on('messageCreate', async (message) => {
  // Security gate: only respond to allowed users in the designated channels
  if (message.author.bot) return;
  if (!ALLOWED_USER_IDS.has(message.author.id)) return;

  const channelId = message.channel.id;
  const userId = message.author.id;

  // Dry-test mode: laptop bot only handles the dedicated #dry-test channel.
  // VPS bot has DRY_TEST_ONLY unset → falls through to the existing
  // prod channel routing untouched.
  if (DRY_TEST_ONLY) {
    if (channelId !== DRY_TEST_CHANNEL_ID) return;
    await handleDryTestChannel(message, userId);
    return;
  }

  const isLeadsChannel   = channelId === LEADS_CHANNEL_ID;
  const isOnboardChannel = channelId === ONBOARD_CHANNEL_ID;
  if (!isLeadsChannel && !isOnboardChannel) return;

  // ─── Onboard channel: only handle onboard commands ──────────────────────────
  // (If LEADS_CHANNEL_ID === ONBOARD_CHANNEL_ID via legacy fallback, we fall
  // through to the leads section after onboard commands don't match.)
  if (isOnboardChannel) {
    const handled = await handleOnboardChannel(message, userId);
    if (handled) return;
    if (!isLeadsChannel) return; // pure onboard channel — ignore non-onboard chatter
  }

  // ─── Leads channel: shortage replies + upload commands ──────────────────────

  // Check if we're waiting on a shortage reply from this user
  if (pendingShortages.has(userId)) {
    const pendingState = pendingShortages.get(userId);

    // Expired — treat as a fresh command
    if (Date.now() > pendingState.expiresAt) {
      pendingShortages.delete(userId);
    } else {
      await handleShortageReply(message, pendingState).catch(console.error);
      return;
    }
  }

  // Parse the message as an upload command
  const result = parseUploadCommand(message.content);

  if (!result.success) {
    await message.reply(
      `Couldn't parse your command. Missing: **${result.missing.join(', ')}**.\n\n` +
      'Format: `Upload <count> <state> <service> into <account> and trigger <workflow>`\n' +
      `Valid services: ${VALID_SERVICES.join(', ')}`
    );
    return;
  }

  const { params } = result;

  // Validate service and CSV existence
  const validation = validateParams(params);
  if (!validation.valid) {
    await message.reply(`Validation error: ${validation.error}`);
    return;
  }

  // Debounce: reject an identical command from the same user within DEBOUNCE_MS.
  // Guards against accidental double-tap / ENTER mashing / Discord retries.
  const hash = commandHash(params);
  const recent = recentCommands.get(userId);
  if (recent && recent.hash === hash && Date.now() - recent.timestamp < DEBOUNCE_MS) {
    const ago = Math.round((Date.now() - recent.timestamp) / 1000);
    await message.reply(
      `Ignoring duplicate command — the identical upload was requested ${ago}s ago. ` +
      `Wait at least ${Math.ceil(DEBOUNCE_MS / 1000)}s between identical commands.`
    );
    return;
  }

  // Global mutex: refuse to start a new upload while one is already running.
  // Prevents two concurrent uploads from racing on overlapping CSV rows.
  if (currentUpload) {
    const elapsed = Math.round((Date.now() - currentUpload.startedAt) / 1000);
    const p = currentUpload.params;
    await message.reply(
      `An upload is already in progress (running ${elapsed}s: ${p.count} ${p.state} ${p.service} → ${p.account}). ` +
      `Wait for it to finish before starting another.`
    );
    return;
  }

  // Check for lead shortage BEFORE spawning (uploader would prompt stdin otherwise)
  let shortageInfo;
  try {
    shortageInfo = checkShortage(params);
  } catch (err) {
    await message.reply(`Error checking lead availability: ${err.message}`);
    return;
  }

  if (shortageInfo.shortage) {
    const { available } = shortageInfo;
    pendingShortages.set(userId, {
      params,
      available,
      expiresAt: Date.now() + SHORTAGE_TTL_MS,
    });

    await message.reply(
      `Only **${available}** unused ${params.state} ${params.service} leads remaining. You asked for ${params.count}.\n\n` +
      `Options:\n` +
      `• \`1\` — upload only the ${available} available\n` +
      `• \`2 GA\` — upload ${available} from ${params.state} and fill the remaining ${params.count - available} from another state (replace GA with your choice)\n\n` +
      `Reply with your choice (expires in 5 minutes).`
    );
    return;
  }

  // All clear — run the upload
  await runUpload(message, params).catch(console.error);
});

/**
 * Handle messages in the #dry-test channel (laptop bot only, DRY_TEST_ONLY=true).
 * Supports three commands:
 *   - `onboard dry test pinnacle <location_id>` — set up a fresh dry-test profile
 *   - `reset dry test`                          — wipe data/clients/dry-test/
 *   - `continue`                                — resolve a pending pause-point or pending onboard
 */
async function handleDryTestChannel(message, userId) {
  const content = message.content.trim();
  const dataDir = path.join(__dirname, '../data');

  // reset dry test
  if (/^reset\s+dry\s+test$/i.test(content)) {
    const result = dryTest.resetDryTest({ slug: 'dry-test', dataDir });
    pendingOnboards.delete(userId);
    pendingContinues.delete(userId);
    if (!result.wiped) {
      await message.reply('nothing to reset');
    } else {
      await message.reply(
        '🧹 wiped data/clients/dry-test/ — ready for fresh `onboard dry test pinnacle <id>`'
      );
    }
    return;
  }

  // continue (resolve a pause-point inside the running pipeline)
  if (/^continue$/i.test(content) && pendingContinues.has(userId)) {
    const resolve = pendingContinues.get(userId);
    pendingContinues.delete(userId);
    resolve();
    return;
  }

  // continue (resolve a pending dry-test onboard waiting for confirmation)
  if (/^continue$/i.test(content) && pendingOnboards.has(userId)) {
    const pending = pendingOnboards.get(userId);
    if (pending.expiresAt < Date.now()) {
      pendingOnboards.delete(userId);
      await message.reply('Onboard session expired. Run `onboard dry test pinnacle <id>` again.');
      return;
    }
    pendingOnboards.delete(userId);
    await runOnboardPipeline(message, pending.clientSlug);
    return;
  }

  // onboard dry test pinnacle <location_id>
  const parsed = dryTest.parseDryTestTrigger(content);
  if (parsed.ok) {
    const slug = 'dry-test';
    const { assetsDir } = dryTest.prepareDryTestProfile({
      slug, location_id: parsed.location_id, dataDir,
    });

    let savedFiles = [];
    if (message.attachments && message.attachments.size > 0) {
      savedFiles = await saveOnboardAttachments(message.attachments, assetsDir);
    }

    pendingOnboards.set(userId, {
      clientSlug: slug,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    await message.reply(
      `🧪 Dry test ready\n` +
      `Location: \`${parsed.location_id}\`\n` +
      `Folder: \`data/clients/dry-test/\`\n` +
      `Attachments saved: ${savedFiles.length ? savedFiles.join(', ') : '(none — drop selfies + logo, then run again)'}\n\n` +
      `Type \`continue\` to run all 11 phases.`
    );
    return;
  }

  // Trigger looked like dry-test but parse failed — give a helpful error
  if (/^onboard\s+dry\s+test/i.test(content)) {
    await message.reply(
      '⚠️ Dry test needs a location_id: `onboard dry test pinnacle <location_id>`\n' +
      'Where `<location_id>` is the GHL sub-account ID (alphanumeric, hyphens or underscores only).'
    );
  }
}

/**
 * Handle messages in the onboard channel. Returns true if the message was
 * recognized as an onboard command (or pending-onboard reply), false otherwise.
 */
async function handleOnboardChannel(message, userId) {
  // ─── Onboard: Sync assets on "update" ──────────────────────────────────────
  if (pendingOnboards.has(userId) && /^update$/i.test(message.content.trim())) {
    const pending = pendingOnboards.get(userId);
    if (Date.now() > pending.expiresAt) {
      pendingOnboards.delete(userId);
      await message.reply('Onboard session expired. Run `onboard <name>` again.');
      return true;
    }

    const slug = pending.clientSlug;
    const reqDir = '/root/smma-agency/.sync-requests';
    fs.mkdirSync(reqDir, { recursive: true });

    // Clear any stale flag files from previous runs
    for (const ext of ['.pending', '.done', '.error']) {
      try { fs.unlinkSync(path.join(reqDir, slug + ext)); } catch {}
    }

    // Write pending flag for the local watcher to pick up
    fs.writeFileSync(path.join(reqDir, slug + '.pending'), '');
    await message.reply(`🔄 Syncing \`${slug}\` assets from your Mac...`);

    // Poll for done/error flag (max 30s)
    const start = Date.now();
    const donePath = path.join(reqDir, slug + '.done');
    const errorPath = path.join(reqDir, slug + '.error');

    const pollInterval = setInterval(async () => {
      try {
        if (fs.existsSync(donePath)) {
          clearInterval(pollInterval);
          fs.unlinkSync(donePath);
          await message.reply(`✅ \`${slug}\` assets synced to VPS. Type \`continue\` to run the pipeline.`);
          return;
        }
        if (fs.existsSync(errorPath)) {
          clearInterval(pollInterval);
          const err = fs.readFileSync(errorPath, 'utf8').trim();
          fs.unlinkSync(errorPath);
          await message.reply(`❌ Sync failed: ${err}`);
          return;
        }
        if (Date.now() - start > 30000) {
          clearInterval(pollInterval);
          // Clean up the pending flag since nobody is listening
          try { fs.unlinkSync(path.join(reqDir, slug + '.pending')); } catch {}
          await message.reply('❌ Sync timed out after 30s. Make sure `sync-watcher.sh` is running on your Mac.');
        }
      } catch (e) {
        clearInterval(pollInterval);
        await message.reply(`❌ Sync error: ${e.message}`);
      }
    }, 1000);
    return true;
  }

  // ─── Orchestrator: Resume on "continue" ──────────────────────────────────
  if (pendingContinues.has(userId) && /^continue$/i.test(message.content.trim())) {
    const resolve = pendingContinues.get(userId);
    pendingContinues.delete(userId);
    resolve();
    return true;
  }

  // ─── Onboard: Resume on "continue" ─────────────────────────────────────────
  if (pendingOnboards.has(userId) && /^continue$/i.test(message.content.trim())) {
    const pending = pendingOnboards.get(userId);
    if (Date.now() > pending.expiresAt) {
      pendingOnboards.delete(userId);
      await message.reply('Onboard session expired. Run `onboard <name>` again.');
      return true;
    }
    pendingOnboards.delete(userId);
    await runOnboardPipeline(message, pending.clientSlug);
    return true;
  }

  // ─── Onboard Dry Test ─────────────────────────────────────────────────────
  // Format: `onboard <source> dry test`
  // Clones onboarding.json + meta-config.json from <source> client into
  // `data/clients/dry-test/`, overrides location_id to DRY_TEST_LOCATION_ID,
  // and runs the full pipeline against the cloned data. Phase 1's idempotency
  // guard short-circuits the email parse since the cloned data is already
  // populated; Phases 2-11 run normally (Phase 2 creates a fresh PIT for the
  // new sub-account). Phase 11 creates a 2nd campaign in the source client's
  // Meta ad account alongside the existing one (Meta allows duplicate names).
  const dryTestMatch = message.content.trim().match(/^onboard\s+(.+?)\s+dry\s+test$/i);
  if (dryTestMatch) {
    const sourceQuery = dryTestMatch[1].trim().toLowerCase();
    const clientsDir = path.join(__dirname, '../data/clients');
    const allClients = fs.existsSync(clientsDir)
      ? fs.readdirSync(clientsDir).filter(d => {
          try { return fs.statSync(path.join(clientsDir, d)).isDirectory(); } catch { return false; }
        })
      : [];
    const matches = allClients.filter(c => c.toLowerCase().startsWith(sourceQuery) || c.toLowerCase().includes(sourceQuery));

    if (matches.length === 0) {
      await message.reply(`No client folder matches \`${sourceQuery}\`. Existing clients: ${allClients.join(', ') || '(none)'}`);
      return true;
    }
    if (matches.length > 1) {
      await message.reply(`Multiple matches for \`${sourceQuery}\`: ${matches.join(', ')}. Be more specific.`);
      return true;
    }

    const sourceSlug = matches[0];
    const sourceOnboarding = path.join(clientsDir, sourceSlug, 'onboarding.json');
    const sourceMetaConfig = path.join(clientsDir, sourceSlug, 'meta-config.json');

    if (!fs.existsSync(sourceOnboarding)) {
      await message.reply(`Source \`${sourceSlug}\` has no \`onboarding.json\` — can't clone.`);
      return true;
    }
    if (!fs.existsSync(sourceMetaConfig)) {
      await message.reply(`Source \`${sourceSlug}\` has no \`meta-config.json\` — can't clone.`);
      return true;
    }

    const targetDir = path.join(clientsDir, DRY_TEST_SLUG);
    const targetAssets = path.join(targetDir, 'assets');
    fs.mkdirSync(targetAssets, { recursive: true });

    const onb = JSON.parse(fs.readFileSync(sourceOnboarding, 'utf-8'));
    onb.location_id = DRY_TEST_LOCATION_ID;
    fs.writeFileSync(path.join(targetDir, 'onboarding.json'), JSON.stringify(onb, null, 2));
    fs.copyFileSync(sourceMetaConfig, path.join(targetDir, 'meta-config.json'));

    // Pull selfies + logo from the source client's assets folder. The
    // pipeline reads inputs from `data/clients/<slug>/assets/`, so we copy
    // (rather than symlink) the source inputs in. Pipeline outputs still
    // land here in dry-test/assets/, leaving the source folder untouched.
    const sourceAssetsDir = path.join(clientsDir, sourceSlug, 'assets');
    const exts = ['jpg', 'jpeg', 'png', 'webp'];
    const inputBases = ['selfie', 'selfie-1', 'selfie-2', 'logo'];
    const copied = [];
    for (const base of inputBases) {
      for (const ext of exts) {
        const src = path.join(sourceAssetsDir, `${base}.${ext}`);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(targetAssets, `${base}.${ext}`));
          copied.push(`${base}.${ext}`);
          break; // first matching extension wins
        }
      }
    }

    const hasSelfie = ['selfie', 'selfie-1', 'selfie-2'].some(b => copied.some(f => f.startsWith(`${b}.`)));
    const hasLogo = copied.some(f => f.startsWith('logo.'));
    if (!hasSelfie || !hasLogo) {
      const missing = [!hasSelfie && 'selfie', !hasLogo && 'logo'].filter(Boolean);
      await message.reply(`Source \`${sourceSlug}\` is missing **${missing.join(', ')}** in its assets folder — can't clone for dry test.`);
      return true;
    }

    pendingOnboards.set(userId, { clientSlug: DRY_TEST_SLUG, expiresAt: Date.now() + 30 * 60 * 1000 });

    await message.reply(
      `🧪 Dry test cloned from \`${sourceSlug}\`\n` +
      `Folder: \`data/clients/${DRY_TEST_SLUG}/\` (outputs land here, source is untouched)\n` +
      `Inputs pulled from \`${sourceSlug}/assets/\`: ${copied.join(', ')}\n` +
      `Sub-account: \`${DRY_TEST_LOCATION_ID}\` (Phase 2 will create the PIT during the run)\n` +
      `Meta: same ad account / pixel as \`${sourceSlug}\` — campaigns added alongside existing ones\n\n` +
      `Type \`continue\` to run all 11 phases.`
    );
    return true;
  }

  // ─── Defense: refuse `onboard dry test ...` in non-dry-test mode ──────────────
  // The dedicated dry-test bot (DRY_TEST_ONLY=true) is the only path that
  // should accept these commands. If a production bot sees one (e.g. someone
  // added the dry-test channel ID to DISCORD_ONBOARD_CHANNEL_ID by mistake),
  // reply with a clear error instead of letting the greedy ^onboard\s+(.+)$
  // regex below treat "dry test pinnacle <id>" as a client slug.
  if (/^onboard\s+dry\s+test\b/i.test(message.content.trim())) {
    await message.reply(
      '⚠️ This bot is not in dry-test mode (`DRY_TEST_ONLY` is not set). ' +
      'Dry-test runs go to a dedicated laptop bot listening on the dry-test ' +
      'channel. Nothing has been written.'
    );
    return true;
  }

  // ─── Onboard Command ──────────────────────────────────────────────────────────
  const onboardMatch = message.content.trim().match(/^onboard\s+(.+)$/i);
  if (onboardMatch) {
    // Convert name to slug: "New View Renovations" → "new-view-renovations"
    const clientSlug = onboardMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
    const assetsDir = path.join(__dirname, `../data/clients/${clientSlug}/assets`);
    fs.mkdirSync(assetsDir, { recursive: true });

    // If the onboard message has image attachments, save them straight to
    // the assets folder. Naming: anything with "logo" in the filename →
    // logo.{ext}; first non-logo image → selfie-1.{ext}; second → selfie-2.
    if (message.attachments && message.attachments.size > 0) {
      const saved = await saveOnboardAttachments(message.attachments, assetsDir);
      if (saved.length > 0) {
        await message.reply(`📎 Saved ${saved.length} attachment(s): ${saved.join(', ')}`);
      }
    }

    // Check for required assets (after potential attachment-save above)
    const hasSelfie = ['jpg', 'jpeg', 'png', 'webp'].some(ext =>
      fs.existsSync(path.join(assetsDir, `selfie.${ext}`)) ||
      fs.existsSync(path.join(assetsDir, `selfie-1.${ext}`))
    );
    const hasLogo = ['jpg', 'jpeg', 'png', 'webp'].some(ext => fs.existsSync(path.join(assetsDir, `logo.${ext}`)));

    if (!hasSelfie || !hasLogo) {
      const missing = [!hasSelfie && 'selfie', !hasLogo && 'logo'].filter(Boolean);
      pendingOnboards.set(userId, { clientSlug, expiresAt: Date.now() + 30 * 60 * 1000 });
      await message.reply(
        `Folder created: \`data/clients/${clientSlug}/assets/\`\n\n` +
        `Missing: **${missing.join(', ')}** — drop ${missing.map(m => `\`${m}.png\``).join(' and ')} as attachments here (or upload to the folder), then type \`continue\`.`
      );
      return true;
    }

    await runOnboardPipeline(message, clientSlug);
    return true;
  }

  return false;
}

client.once('clientReady', async () => {
  console.log(`Bot online — logged in as ${client.user.tag}`);

  // Post startup ping to each configured channel (deduped if both env vars point to the same one)
  const startupChannels = [...new Set([LEADS_CHANNEL_ID, ONBOARD_CHANNEL_ID].filter(Boolean))];
  for (const id of startupChannels) {
    try {
      const channel = await client.channels.fetch(id);
      await channel.send('Lead Uploader Bot is online.');
    } catch (err) {
      console.error(`Could not send startup message to channel ${id}:`, err.message);
    }
  }

  // ─── Whop → wins channel watcher ────────────────────────────────────────────
  if (!WHOP_API_KEY) {
    console.warn('[whop-watcher] WHOP_API_KEY not set — skipping wins channel notifications');
  } else if (!WINS_CHANNEL_ID) {
    console.warn('[whop-watcher] WINS_CHANNEL_ID not set — skipping wins channel notifications');
  } else {
    const statePath = path.join(__dirname, '../data/whop/seen-payments.json');
    let winsChannel;
    try {
      winsChannel = await client.channels.fetch(WINS_CHANNEL_ID);
    } catch (err) {
      console.error(`[whop-watcher] could not fetch wins channel ${WINS_CHANNEL_ID}: ${err.message}`);
    }
    if (winsChannel) {
      startWhopWatcher({
        apiKey: WHOP_API_KEY,
        statePath,
        intervalMs: 60_000,
        onNewPayment: async (p) => {
          const amount = paymentAmount(p);
          await winsChannel.send(formatWinMessage(amount));
          console.log(`[whop-watcher] announced payment ${p.id} ($${amount})`);
        },
        log: (lvl, msg) => {
          if (lvl === 'error') console.error(`[whop-watcher] ${msg}`);
          else console.log(`[whop-watcher] ${msg}`);
        },
      });
      console.log(`[whop-watcher] started — polling every 60s, posting to ${WINS_CHANNEL_ID}`);
    }
  }
});

// Log connection issues without crashing
client.on('error', (err) => {
  console.error('Discord client error:', err.message);
});

client.on('warn', (info) => {
  console.warn('Discord warning:', info);
});

client.login(DISCORD_BOT_TOKEN).catch((err) => {
  console.error('Failed to log in to Discord:', err.message);
  process.exit(1);
});
