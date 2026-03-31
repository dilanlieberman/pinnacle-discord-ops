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
 *   DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_OWNER_ID
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ─── Dependencies & Config ────────────────────────────────────────────────────

const { Client, GatewayIntentBits } = require('discord.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const { DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_OWNER_ID, DISCORD_ALLOWED_USERS } = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_CHANNEL_ID || !DISCORD_OWNER_ID) {
  console.error('Missing required env vars: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_OWNER_ID');
  process.exit(1);
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

  // Match "2 GA" or "2 Georgia" etc.
  const option2Match = text.match(/^2\s+([A-Za-z]{2,}(?:\s+[A-Za-z]+)*)$/);
  if (option2Match) {
    pendingShortages.delete(message.author.id);
    const stateInput = option2Match[1].trim();
    // Normalize to abbreviation
    const fillState = STATE_ABBREVS[stateInput.toLowerCase()] ?? stateInput.toUpperCase();

    if (!VALID_STATE_ABBREVS.has(fillState)) {
      await message.reply(`Unknown state "${stateInput}". Use a 2-letter abbreviation like GA, TX, FL.`);
      return;
    }

    const needed = params.count - available;
    const cmd1 = buildCommandString({ ...params, count: available });
    const cmd2 = buildCommandString({ ...params, state: fillState, count: needed });

    await message.reply(
      `To fill from ${fillState}, run these two uploads separately:\n` +
      `**1.** \`${cmd1}\`\n` +
      `**2.** \`${cmd2}\``
    );
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
 * Read the most recently modified upload log from data/logs/.
 */
function readMostRecentLog() {
  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.startsWith('upload-') && f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(LOGS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) throw new Error('No log files found in data/logs/');

  return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, files[0].name), 'utf8'));
}

/**
 * Spawn ghl-lead-uploader.js as a child process and report results to Discord.
 */
async function runUpload(message, params) {
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
    child.on('error', async (err) => {
      await message.reply(`Failed to start upload process: ${err.message}`).catch(console.error);
      resolve();
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        const errMsg = stderrBuffer.trim().slice(0, 1800) || `Process exited with code ${code}`;
        await message.reply(`Upload failed (exit code ${code}):\n\`\`\`\n${errMsg}\n\`\`\``).catch(console.error);
        resolve();
        return;
      }

      try {
        const logData = readMostRecentLog();
        const s = logData.summary;
        await message.reply(
          `Done! Uploaded: ${s.uploaded} | Skipped: ${s.skipped} | Failed: ${s.failed} | Time: ${formatDuration(s.durationSeconds)}`
        );
      } catch (logErr) {
        await message.reply(`Upload completed but couldn't read log file: ${logErr.message}`).catch(console.error);
      }

      resolve();
    });
  });
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
  // Security gate: only respond to allowed users in the designated channel
  if (message.author.bot) return;
  if (!ALLOWED_USER_IDS.has(message.author.id)) return;
  if (message.channel.id !== DISCORD_CHANNEL_ID) return;

  const userId = message.author.id;

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

client.once('clientReady', async () => {
  console.log(`Bot online — logged in as ${client.user.tag}`);

  try {
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    await channel.send('Lead Uploader Bot is online.');
  } catch (err) {
    console.error('Could not send startup message to channel:', err.message);
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
