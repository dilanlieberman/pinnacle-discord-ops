/**
 * ghl-lead-uploader.js
 *
 * Bulk-uploads leads from a per-state CSV into a GoHighLevel sub-account
 * and enrolls each contact in a specified workflow.
 *
 * Usage:
 *   node scripts/ghl-lead-uploader.js \
 *     --service remodelers \
 *     --state AL \
 *     --count 1500 \
 *     --account "coleton sub acc 1" \
 *     --workflow "boom"
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const { parse } = require('csv-parse/sync');

// ─── Constants ───────────────────────────────────────────────────────────────

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const RATE_DELAY_MS = 250;      // 250ms between contacts = ~4 contacts/sec = 8 req/sec (well under 100/10s)
const RETRY_WAIT_MS = 60_000;   // wait 60s on 429
const MAX_RETRIES = 3;
const PROGRESS_INTERVAL = 50;   // log every N contacts

const LEADS_DIR = path.join(__dirname, '../data/leads/all_contacts_final');
const TRACKING_FILE = path.join(__dirname, '../data/leads/tracking.json');
const LOGS_DIR = path.join(__dirname, '../data/logs');
const SUB_ACCOUNT_TOKENS_FILE = path.join(__dirname, '../data/sub-account-tokens.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pause execution for ms milliseconds */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Prompt the user for input via stdin */
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Build standard GHL axios headers */
function ghlHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    'Content-Type': 'application/json',
  };
}

/** Format seconds into "Xm Ys" */
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Return today's date as YYYY-MM-DD */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Return timestamp string YYYY-MM-DD-HHMMSS for log filenames */
function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ─── CLI Arg Parsing ─────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      parsed[key] = args[i + 1];
      i++;
    }
  }

  const required = ['service', 'state', 'count', 'account', 'workflow'];
  const missing = required.filter((k) => !parsed[k]);
  if (missing.length > 0) {
    console.error(`Missing required arguments: ${missing.map((k) => '--' + k).join(', ')}`);
    console.error('\nUsage:');
    console.error('  node scripts/ghl-lead-uploader.js \\');
    console.error('    --service remodelers \\');
    console.error('    --state AL \\');
    console.error('    --count 1500 \\');
    console.error('    --account "sub account name" \\');
    console.error('    --workflow "workflow name"');
    process.exit(1);
  }

  return {
    service: parsed.service,
    state: parsed.state.toUpperCase(),
    count: parseInt(parsed.count, 10),
    account: parsed.account,
    workflow: parsed.workflow,
  };
}

// ─── Tracking File ───────────────────────────────────────────────────────────

function loadTracking() {
  if (!fs.existsSync(TRACKING_FILE)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'));
}

function saveTracking(tracking) {
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2));
}

// ─── Sub-Account Token Lookup ────────────────────────────────────────────────

/**
 * Load the location-specific API token from data/sub-account-tokens.json.
 * Exits with a clear message if the file is missing or the locationId has no entry.
 */
function loadSubAccountToken(locationId) {
  if (!fs.existsSync(SUB_ACCOUNT_TOKENS_FILE)) {
    console.error('Error: data/sub-account-tokens.json not found.');
    console.error('Create it with the sub-account\'s Private Integration token:');
    console.error(`  { "${locationId}": { "name": "...", "token": "pit-..." } }`);
    process.exit(1);
  }

  const tokens = JSON.parse(fs.readFileSync(SUB_ACCOUNT_TOKENS_FILE, 'utf8'));

  if (!tokens[locationId]) {
    console.error(`Error: No token found in data/sub-account-tokens.json for location "${locationId}".`);
    console.error('To fix:');
    console.error('  1. In GHL, go to the sub-account → Settings → Integrations → Private Integrations');
    console.error('  2. Create a new Private Integration token with Contacts + Workflows scopes');
    console.error(`  3. Add it to data/sub-account-tokens.json under the key "${locationId}"`);
    process.exit(1);
  }

  return tokens[locationId].token;
}

// ─── CSV Loading ─────────────────────────────────────────────────────────────

/**
 * Load a CSV and return all data rows as objects.
 * Columns: name, city, phone, notes
 */
function loadCSV(service, state) {
  const csvPath = path.join(LEADS_DIR, service, `${state}.csv`);
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    console.error(`Available states in "${service}":`);
    try {
      const files = fs.readdirSync(path.join(LEADS_DIR, service));
      files.forEach((f) => console.error(`  ${f.replace('.csv', '')}`));
    } catch {
      console.error('  (could not read service directory)');
    }
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  return rows;
}

// ─── GHL Sub-Account Lookup ──────────────────────────────────────────────────

/**
 * Paginate through all GHL sub-accounts and find ones matching the search string.
 * Returns an array of matching location objects.
 */
async function findSubAccounts(token, searchName) {
  const LIMIT = 20;
  const all = [];
  let offset = 0;

  console.log('Looking up GHL sub-accounts...');
  while (true) {
    const res = await axios.get(`${GHL_BASE}/locations/search`, {
      headers: ghlHeaders(token),
      params: { limit: LIMIT, skip: offset },
    });

    const page = res.data.locations ?? res.data;
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < LIMIT) break;
    offset += LIMIT;
  }

  const matches = all.filter((loc) =>
    loc.name.toLowerCase().includes(searchName.toLowerCase())
  );

  return { all, matches };
}

async function resolveSubAccount(token, accountName) {
  const { all, matches } = await findSubAccounts(token, accountName);

  if (matches.length === 0) {
    console.error(`No sub-account found matching "${accountName}".`);
    console.error('\nAvailable sub-accounts:');
    all.forEach((loc, i) => console.error(`  ${i + 1}. ${loc.name}`));
    process.exit(1);
  }

  if (matches.length === 1) {
    console.log(`Found sub-account: ${matches[0].name} (${matches[0].id})`);
    return matches[0];
  }

  // Multiple matches — ask user to pick
  console.log(`Multiple sub-accounts match "${accountName}":`);
  matches.forEach((loc, i) => console.log(`  ${i + 1}. ${loc.name} (${loc.id})`));
  const answer = await prompt('Enter the number of the sub-account to use: ');
  const idx = parseInt(answer, 10) - 1;
  if (idx < 0 || idx >= matches.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  return matches[idx];
}

// ─── GHL Workflow Lookup ─────────────────────────────────────────────────────

async function resolveWorkflow(token, locationId, workflowName) {
  console.log('Looking up workflows...');
  let res;
  try {
    res = await axios.get(`${GHL_BASE}/workflows/`, {
      headers: ghlHeaders(token),
      params: { locationId },
    });
  } catch (err) {
    if (err.response?.status === 401) {
      console.error('Error: 401 Unauthorized when fetching workflows.');
      console.error('Your GHL Private Integration Token may be missing the "workflows.readonly" scope.');
      console.error('Fix: Go to GHL → Settings → Integrations → Private Integrations → edit your token → enable Workflows scope.');
      process.exit(1);
    }
    throw err;
  }

  const workflows = res.data.workflows ?? res.data ?? [];
  const matches = workflows.filter((wf) =>
    wf.name.toLowerCase().includes(workflowName.toLowerCase())
  );

  if (matches.length === 0) {
    console.error(`No workflow found matching "${workflowName}".`);
    console.error('\nAvailable workflows:');
    workflows.forEach((wf, i) => console.error(`  ${i + 1}. ${wf.name}`));
    process.exit(1);
  }

  if (matches.length === 1) {
    console.log(`Found workflow: ${matches[0].name} (${matches[0].id})`);
    return matches[0];
  }

  // Multiple matches — ask user to pick
  console.log(`Multiple workflows match "${workflowName}":`);
  matches.forEach((wf, i) => console.log(`  ${i + 1}. ${wf.name} (${wf.id})`));
  const answer = await prompt('Enter the number of the workflow to use: ');
  const idx = parseInt(answer, 10) - 1;
  if (idx < 0 || idx >= matches.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  return matches[idx];
}

// ─── Contact Upload ──────────────────────────────────────────────────────────

/**
 * Create a single contact in GHL. Returns the created contact object.
 * Throws on error — caller handles retry/skip logic.
 */
async function createContact(token, locationId, row) {
  const parts = row.name.trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';

  const body = {
    locationId,
    firstName,
    lastName,
    phone: row.phone,
    city: row.city,
  };

  const res = await axios.post(`${GHL_BASE}/contacts/`, body, {
    headers: ghlHeaders(token),
  });

  return res.data.contact ?? res.data;
}

/**
 * Enroll a contact in a workflow.
 */
async function triggerWorkflow(token, contactId, workflowId) {
  await axios.post(
    `${GHL_BASE}/contacts/${contactId}/workflow/${workflowId}`,
    {},
    { headers: ghlHeaders(token) }
  );
}

/**
 * Attempt an API call with retry on 429 (rate limit).
 * Up to MAX_RETRIES retries with RETRY_WAIT_MS wait between each.
 */
async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) {
        console.error(`Error: 401 Unauthorized on "${label}". Check the sub-account token in data/sub-account-tokens.json.`);
        process.exit(1);
      }
      if (status === 429 && attempt < MAX_RETRIES) {
        console.warn(`Rate limit hit on ${label}. Waiting 60s before retry ${attempt}/${MAX_RETRIES - 1}...`);
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      throw err;
    }
  }
}

// ─── Shortage Handling ───────────────────────────────────────────────────────

/**
 * Check if the primary CSV has enough unused rows.
 * If not, prompt the user for options and return the final rows to upload.
 */
async function resolveRows(args, tracking) {
  const primaryRows = loadCSV(args.service, args.state);
  const primaryKey = `${args.service}/${args.state}`;
  const primaryUsed = tracking[primaryKey]?.usedRows ?? 0;
  const primaryAvailable = primaryRows.length - primaryUsed;

  // Enough leads — no shortage
  if (primaryAvailable >= args.count) {
    return {
      rows: primaryRows.slice(primaryUsed, primaryUsed + args.count),
      primaryKey,
      primaryRows,
    };
  }

  // Shortage — inform user
  console.log('');
  console.log(`Only ${primaryAvailable} unused ${args.state} ${args.service} leads remaining. You asked for ${args.count}.`);
  console.log('Options:');
  console.log(`  1. Upload only the ${primaryAvailable} available`);
  console.log(`  2. Upload ${primaryAvailable} from ${args.state} and fill the remaining ${args.count - primaryAvailable} from another state (specify which)`);
  console.log('');

  const choice = await prompt('Enter option (1 or 2): ');

  if (choice === '1') {
    console.log(`Proceeding with ${primaryAvailable} contacts.`);
    return {
      rows: primaryRows.slice(primaryUsed),
      primaryKey,
      primaryRows,
    };
  }

  if (choice === '2') {
    const secondaryState = (await prompt('Which state should fill the remaining leads? (e.g. GA): ')).toUpperCase();
    const secondaryRows = loadCSV(args.service, secondaryState);
    const secondaryKey = `${args.service}/${secondaryState}`;
    const secondaryUsed = tracking[secondaryKey]?.usedRows ?? 0;
    const secondaryAvailable = secondaryRows.length - secondaryUsed;
    const needed = args.count - primaryAvailable;

    if (secondaryAvailable < needed) {
      console.error(`Not enough leads in ${secondaryState} either — only ${secondaryAvailable} available, need ${needed}.`);
      process.exit(1);
    }

    const combinedRows = [
      ...primaryRows.slice(primaryUsed),
      ...secondaryRows.slice(secondaryUsed, secondaryUsed + needed).map((r) => ({ ...r, _sourceKey: secondaryKey })),
    ];

    console.log(`Using ${primaryAvailable} from ${args.state} + ${needed} from ${secondaryState}.`);
    return {
      rows: combinedRows,
      primaryKey,
      primaryRows,
      secondaryKey,
      secondaryRows,
    };
  }

  console.error('Invalid option. Exiting.');
  process.exit(1);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // Validate token
  const token = process.env.GHL_PRIVATE_TOKEN;
  if (!token) {
    console.error('GHL_PRIVATE_TOKEN not found in .env');
    process.exit(1);
  }

  console.log('');
  console.log(`=== GHL Lead Uploader ===`);
  console.log(`Service:  ${args.service}`);
  console.log(`State:    ${args.state}`);
  console.log(`Count:    ${args.count}`);
  console.log(`Account:  ${args.account}`);
  console.log(`Workflow: ${args.workflow}`);
  console.log('');

  // Load tracking
  const tracking = loadTracking();

  // Resolve rows (with shortage handling)
  const { rows, primaryKey, primaryRows, secondaryKey, secondaryRows } = await resolveRows(args, tracking);
  const totalToUpload = rows.length;

  if (totalToUpload === 0) {
    console.log('No leads to upload. All rows in this CSV have been used.');
    process.exit(0);
  }

  // Initialize tracking entries if needed
  if (!tracking[primaryKey]) {
    tracking[primaryKey] = { totalRows: primaryRows.length, usedRows: 0, lastUploadDate: null };
  }
  if (secondaryKey && !tracking[secondaryKey]) {
    tracking[secondaryKey] = { totalRows: secondaryRows.length, usedRows: 0, lastUploadDate: null };
  }

  // Resolve GHL sub-account (uses agency token), then load the sub-account-level token
  const location = await resolveSubAccount(token, args.account);
  const subToken = loadSubAccountToken(location.id);

  // Use sub-account token for all location-level calls from here on
  const workflow = await resolveWorkflow(subToken, location.id, args.workflow);

  console.log('');
  console.log(`Starting upload of ${totalToUpload} contacts...`);
  console.log('');

  // Upload tracking
  const successful = [];
  const failed = [];
  const duplicates = [];
  const startTime = Date.now();

  // Ensure logs directory exists
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const contactNum = i + 1;

    // Determine which tracking key this row belongs to
    const trackingKey = row._sourceKey ?? primaryKey;

    // Progress log every PROGRESS_INTERVAL contacts
    if (contactNum % PROGRESS_INTERVAL === 0) {
      console.log(`Uploaded ${contactNum}/${totalToUpload} contacts...`);
    }

    try {
      // Create the contact (uses sub-account token)
      let contact;
      try {
        contact = await withRetry(
          () => createContact(subToken, location.id, row),
          `create contact ${row.phone}`
        );
      } catch (err) {
        const status = err.response?.status;

        // Duplicate contact (phone already exists)
        if (status === 409 || err.response?.data?.message?.toLowerCase().includes('duplicate')) {
          duplicates.push({ name: row.name, phone: row.phone });
          // Do NOT increment usedRows for duplicates — the row wasn't consumed
          continue;
        }

        const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        failed.push({ name: row.name, phone: row.phone, error: errMsg });
        continue;
      }

      // Trigger workflow (uses sub-account token)
      try {
        await withRetry(
          () => triggerWorkflow(subToken, contact.id, workflow.id),
          `workflow for ${contact.id}`
        );
      } catch (err) {
        // Contact was created but workflow failed — still counts as uploaded
        const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        console.warn(`  Warning: workflow trigger failed for ${row.name} (${contact.id}): ${errMsg}`);
      }

      successful.push({ contactId: contact.id, name: row.name, phone: row.phone });

      // Update tracking.json immediately after each successful upload
      tracking[trackingKey].usedRows += 1;
      tracking[trackingKey].lastUploadDate = todayISO();
      saveTracking(tracking);

    } catch (err) {
      const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
      failed.push({ name: row.name, phone: row.phone, error: errMsg });
    }

    // Rate limit delay between contacts
    await sleep(RATE_DELAY_MS);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  const logFilename = `upload-${timestampForFilename()}.json`;
  const logPath = path.join(LOGS_DIR, logFilename);

  const logData = {
    params: {
      service: args.service,
      state: args.state,
      count: args.count,
      account: args.account,
      workflow: args.workflow,
      locationId: location.id,
      workflowId: workflow.id,
    },
    summary: {
      uploaded: successful.length,
      skipped: duplicates.length,
      failed: failed.length,
      durationSeconds,
    },
    successful,
    failed,
    duplicates,
  };

  fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));

  console.log('');
  console.log('Upload complete.');
  console.log(`  Uploaded:   ${successful.length}`);
  console.log(`  Skipped:    ${duplicates.length}  (duplicates)`);
  console.log(`  Failed:     ${failed.length}`);
  console.log(`  Time taken: ${formatDuration(durationSeconds)}`);
  console.log(`Log saved to: data/logs/${logFilename}`);
  console.log('');
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
