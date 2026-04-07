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

// Veriphone — roofing leads get phone-validated before upload
const VERIPHONE_BASE = 'https://api.veriphone.io/v2/verify';
const VERIPHONE_API_KEY = process.env.VERIPHONE_API_KEY || 'FE4581490A574286A6BCB3F35C7012AC';
const VERIPHONE_CONCURRENCY = 10;   // how many verify requests in flight at once
const VERIPHONE_PROGRESS_INTERVAL = 100;

const LEADS_DIR = path.join(__dirname, '../data/leads/all_contacts_final');
const TRACKING_FILE = path.join(__dirname, '../data/leads/tracking.json');
const LOGS_DIR = path.join(__dirname, '../data/logs');
const SUB_ACCOUNT_TOKENS_FILE = path.join(__dirname, '../data/sub-account-tokens.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pause execution for ms milliseconds */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Prompt the user for input via stdin.
 *
 * IMPORTANT: When this script is spawned by discord-bot.js, stdin is /dev/null
 * (stdio: ['ignore', ...]). In that case readline.question() never resolves and
 * Node exits cleanly with code 0 the moment nothing else is pending — which
 * looks like a successful run to the parent and produces NO log file. To prevent
 * that silent-failure mode, we hard-fail with a descriptive stderr message
 * whenever a prompt would be needed in a non-interactive context. The parent
 * (discord-bot) sees exit 1 + the stderr explanation instead of a fake success.
 */
function prompt(question) {
  if (!process.stdin.isTTY) {
    console.error('');
    console.error('ERROR: Interactive prompt required but stdin is not a TTY.');
    console.error(`Prompt was: ${question.trim()}`);
    console.error('This usually means a sub-account or workflow name matched');
    console.error('multiple records, or there was a lead shortage. Re-run with');
    console.error('a more specific name, or run the script directly in a terminal.');
    process.exit(1);
  }
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

  // Multiple substring matches — prefer an exact (case-insensitive) match if one exists
  const exact = matches.find((loc) => loc.name.toLowerCase() === accountName.toLowerCase());
  if (exact) {
    console.log(`Found sub-account (exact match): ${exact.name} (${exact.id})`);
    return exact;
  }

  // No exact match — ask user to pick
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

  // Multiple substring matches — prefer an exact (case-insensitive) match if one exists
  const exact = matches.find((wf) => wf.name.toLowerCase() === workflowName.toLowerCase());
  if (exact) {
    console.log(`Found workflow (exact match): ${exact.name} (${exact.id})`);
    return exact;
  }

  // No exact match — ask user to pick
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
 * Look up an existing contact by phone number within a sub-account.
 * Returns the contact object, or null if not found.
 *
 * Used when createContact returns 409 (duplicate) so we can still enroll the
 * existing contact in the target workflow.
 */
async function findContactByPhone(token, locationId, phone) {
  try {
    const res = await axios.get(`${GHL_BASE}/contacts/search/duplicate`, {
      headers: ghlHeaders(token),
      params: { locationId, number: phone },
    });
    return res.data?.contact ?? null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
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
 * Attempt an API call with retry on transient failures.
 *
 * Retries:
 *   - 429 Rate Limit       → wait RETRY_WAIT_MS (60s) and retry
 *   - 5xx server errors    → wait 5s and retry
 *   - Network errors       → wait 5s and retry
 *     (ECONNRESET, ETIMEDOUT, ENOTFOUND, ECONNABORTED, EAI_AGAIN)
 *
 * NEVER retried (immediate throw):
 *   - 4xx client errors other than 429 (bad data — won't fix itself)
 *
 * Hard-fails on 401 (token problem — re-running won't fix it).
 */
async function withRetry(fn, label) {
  const NETWORK_ERROR_CODES = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED', 'EAI_AGAIN', 'EPIPE',
  ]);
  const TRANSIENT_RETRY_DELAY_MS = 5_000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const code = err.code;

      if (status === 401) {
        console.error(`Error: 401 Unauthorized on "${label}". Check the sub-account token in data/sub-account-tokens.json.`);
        process.exit(1);
      }

      const isRateLimit = status === 429;
      const isServerError = typeof status === 'number' && status >= 500 && status < 600;
      const isNetworkError = !status && NETWORK_ERROR_CODES.has(code);
      const isTransient = isRateLimit || isServerError || isNetworkError;

      if (isTransient && attempt < MAX_RETRIES) {
        const wait = isRateLimit ? RETRY_WAIT_MS : TRANSIENT_RETRY_DELAY_MS;
        const reason = isRateLimit ? 'rate limit (429)'
          : isServerError ? `server error (${status})`
          : `network error (${code})`;
        console.warn(`Transient ${reason} on ${label}. Waiting ${wait/1000}s before retry ${attempt}/${MAX_RETRIES - 1}...`);
        await sleep(wait);
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

// ─── Veriphone (roofing leads only) ──────────────────────────────────────────

/**
 * Verify a single phone number against the Veriphone API.
 * Returns { valid: boolean, phoneType: string|null, reason: string|null }.
 *
 * A row is "valid" ONLY if it is BOTH a real phone number AND a mobile line.
 * Landlines, VOIP, toll-free, etc. are dropped — we're texting these contacts
 * via the workflow, so a non-mobile is useless.
 *
 * NOTE: Network/API errors fail-CLOSED (treated as invalid) so a Veriphone
 * outage doesn't silently flood GHL with unverified landlines. The previous
 * fail-open behavior is what produced today's "1957/1957 valid" run.
 */
async function verifySinglePhone(phone) {
  try {
    const res = await axios.get(VERIPHONE_BASE, {
      params: { phone, key: VERIPHONE_API_KEY },
      timeout: 10_000,
    });
    const data = res.data || {};

    // Veriphone returns status: "success" on a good call; non-success = drop
    if (data.status !== 'success') {
      return { valid: false, phoneType: null, reason: `veriphone status=${data.status}` };
    }

    const isValidNumber = data.phone_valid === true;
    const phoneType = data.phone_type || null;
    const isMobile = phoneType === 'mobile';

    return {
      valid: isValidNumber && isMobile,
      phoneType,
      reason: !isValidNumber ? 'invalid number'
        : !isMobile ? `not mobile (${phoneType || 'unknown'})`
        : null,
    };
  } catch (err) {
    // Fail-CLOSED on network errors — better to drop a lead than to upload an
    // unverified one and burn it from the cursor as "consumed".
    return { valid: false, phoneType: null, reason: `verify error: ${err.message}` };
  }
}

/**
 * Run all rows through Veriphone with bounded concurrency.
 * Returns { validRows, invalidRows } — invalidRows keep their original shape
 * plus a `_invalidReason` field used for logging/tracking.
 */
async function verifyPhonesWithVeriphone(rows) {
  console.log(`Verifying ${rows.length} phone numbers via Veriphone...`);

  const results = new Array(rows.length);
  let completed = 0;
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= rows.length) return;
      results[i] = await verifySinglePhone(rows[i].phone);
      completed++;
      if (completed % VERIPHONE_PROGRESS_INTERVAL === 0) {
        console.log(`  Verified ${completed}/${rows.length}...`);
      }
    }
  }

  const workers = Array.from({ length: VERIPHONE_CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const validRows = [];
  const invalidRows = [];
  for (let i = 0; i < rows.length; i++) {
    if (results[i].valid) {
      validRows.push(rows[i]);
    } else {
      invalidRows.push({ ...rows[i], _invalidReason: results[i].reason });
    }
  }

  console.log(`Verification complete: ${validRows.length} valid, ${invalidRows.length} invalid.`);
  return { validRows, invalidRows };
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
  let { rows, primaryKey, primaryRows, secondaryKey, secondaryRows } = await resolveRows(args, tracking);

  // Initialize tracking entries if needed
  if (!tracking[primaryKey]) {
    tracking[primaryKey] = { totalRows: primaryRows.length, usedRows: 0, lastUploadDate: null };
  }
  if (secondaryKey && !tracking[secondaryKey]) {
    tracking[secondaryKey] = { totalRows: secondaryRows.length, usedRows: 0, lastUploadDate: null };
  }

  // ─── Roofing-only: Veriphone validation ────────────────────────────────────
  // Roughly 50% of roofing phones fail verification. To deliver exactly
  // args.count valid contacts to GHL, pull batches of 2x what's still needed,
  // verify, keep the valid ones, and repeat until the target is met or the
  // CSV pool is exhausted. Every row we verify (valid OR invalid, kept OR
  // discarded as "extra") is consumed in tracking.json so the next run picks
  // up cleanly.
  let invalidRows = [];
  if (args.service === 'roofing') {
    const target = args.count;

    if (secondaryKey) {
      // Shortage was already filled from a second state via resolveRows.
      // There's no overflow to pull from, so we just verify the combined set
      // once and accept whatever valid count we get.
      const { validRows: good, invalidRows: bad } = await verifyPhonesWithVeriphone(rows);
      for (const b of bad) {
        const key = b._sourceKey ?? primaryKey;
        tracking[key].usedRows += 1;
        tracking[key].lastUploadDate = todayISO();
      }
      if (bad.length > 0) saveTracking(tracking);
      rows = good;
      invalidRows = bad;
      if (good.length < target) {
        console.log(`Warning: after verification only ${good.length} valid phones (wanted ${target}).`);
      }
    } else {
      // Normal case: draw from primaryRows starting at the current cursor.
      // The initial `rows` array from resolveRows covered only primaryRows[primaryStart..primaryStart+target);
      // we re-slice from primaryStart onward to get the full remaining pool.
      const primaryStart = tracking[primaryKey].usedRows;
      const fullPool = primaryRows.slice(primaryStart);
      let poolIdx = 0;

      const validAccum = [];
      const invalidAccum = [];
      let batchNum = 0;

      while (validAccum.length < target && poolIdx < fullPool.length) {
        batchNum++;
        const needed = target - validAccum.length;
        // Pull 2x what's still needed (min 10) — matches the observed ~50% fail rate.
        const batchSize = Math.min(
          Math.max(Math.ceil(needed * 2), 10),
          fullPool.length - poolIdx
        );
        const batch = fullPool.slice(poolIdx, poolIdx + batchSize);
        poolIdx += batchSize;

        console.log(`Verify batch #${batchNum}: pulling ${batch.length} rows (have ${validAccum.length}/${target} valid)`);
        const { validRows: good, invalidRows: bad } = await verifyPhonesWithVeriphone(batch);
        validAccum.push(...good);
        invalidAccum.push(...bad);

        // Mark every invalid row as consumed immediately so tracking advances
        // even if we crash mid-upload.
        for (let i = 0; i < bad.length; i++) {
          tracking[primaryKey].usedRows += 1;
          tracking[primaryKey].lastUploadDate = todayISO();
        }
        if (bad.length > 0) saveTracking(tracking);
      }

      // If we overshot the target, the extra valid rows won't be uploaded,
      // but they were still positionally pulled from the CSV — mark them
      // consumed so we don't re-verify them next run.
      const extras = validAccum.slice(target);
      for (let i = 0; i < extras.length; i++) {
        tracking[primaryKey].usedRows += 1;
        tracking[primaryKey].lastUploadDate = todayISO();
      }
      if (extras.length > 0) saveTracking(tracking);

      rows = validAccum.slice(0, target);
      invalidRows = invalidAccum;

      console.log(`Verification done: ${validAccum.length} valid found, ${invalidAccum.length} invalid dropped, ${extras.length} extras discarded.`);
      if (validAccum.length < target) {
        console.log(`Warning: CSV pool exhausted. Got ${validAccum.length} valid phones, wanted ${target}.`);
      }
    }
  }

  const totalToUpload = rows.length;

  if (totalToUpload === 0) {
    console.log('No leads to upload after validation.');
    process.exit(0);
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

  // Capture starting cursor position(s) so we can verify the invariant at the
  // end: cursor must advance by EXACTLY rows.length. If it doesn't, the
  // "1000 in → 1000 consumed → never re-used" guarantee is broken.
  const cursorBefore = {
    [primaryKey]: tracking[primaryKey].usedRows,
    ...(secondaryKey ? { [secondaryKey]: tracking[secondaryKey].usedRows } : {}),
  };

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

        // Duplicate contact (phone already exists in this sub-account).
        // Fetch the existing contact, enroll it in the target workflow, and
        // ADVANCE tracking. Rationale: semantically the row IS consumed (the
        // phone is now associated with this workflow), and NOT advancing
        // tracking causes the cursor to get stuck re-fighting the same
        // duplicate rows on every subsequent run.
        if (status === 409 || err.response?.data?.message?.toLowerCase().includes('duplicate')) {
          duplicates.push({ name: row.name, phone: row.phone });

          try {
            const existing = await withRetry(
              () => findContactByPhone(subToken, location.id, row.phone),
              `lookup duplicate ${row.phone}`
            );
            if (existing?.id) {
              await withRetry(
                () => triggerWorkflow(subToken, existing.id, workflow.id),
                `workflow for existing ${existing.id}`
              );
            } else {
              console.warn(`  Warning: 409 duplicate but contact lookup returned nothing for ${row.phone}`);
            }
          } catch (lookupErr) {
            const errMsg = lookupErr.response ? JSON.stringify(lookupErr.response.data) : lookupErr.message;
            console.warn(`  Warning: failed to enroll duplicate ${row.phone} in workflow: ${errMsg}`);
          }

          // Advance tracking so we don't re-process this row next run
          tracking[trackingKey].usedRows += 1;
          tracking[trackingKey].lastUploadDate = todayISO();
          saveTracking(tracking);

          await sleep(RATE_DELAY_MS);
          continue;
        }

        // Permanent failure (4xx other than 429/409, or transient retries
        // exhausted). Advance the cursor anyway so this row is "consumed" —
        // the invariant is "1000 in → 1000 cursor-advances → never re-used".
        // The failed row is preserved in the log for manual recovery.
        const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        failed.push({ name: row.name, phone: row.phone, error: errMsg });
        tracking[trackingKey].usedRows += 1;
        tracking[trackingKey].lastUploadDate = todayISO();
        saveTracking(tracking);
        await sleep(RATE_DELAY_MS);
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
      // Catch-all for unexpected errors thrown OUTSIDE the create/workflow
      // try-blocks (e.g., a programming bug). Same invariant: this row is
      // consumed, advance the cursor, log the failure for forensics.
      const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
      failed.push({ name: row.name, phone: row.phone, error: errMsg });
      try {
        tracking[trackingKey].usedRows += 1;
        tracking[trackingKey].lastUploadDate = todayISO();
        saveTracking(tracking);
      } catch (trackErr) {
        console.error(`  CRITICAL: failed to advance tracking for ${row.phone}: ${trackErr.message}`);
      }
    }

    // Rate limit delay between contacts
    await sleep(RATE_DELAY_MS);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  const logFilename = `upload-${timestampForFilename()}.json`;
  const logPath = path.join(LOGS_DIR, logFilename);

  // ─── Invariant check ───────────────────────────────────────────────────────
  // The cursor MUST have advanced by exactly rows.length across all involved
  // tracking keys. If not, the "1000 in → 1000 cursor-advances → never re-used"
  // guarantee is broken — fail loudly so the bot reports the problem instead
  // of silently succeeding with corrupted tracking.
  const cursorAfter = {
    [primaryKey]: tracking[primaryKey].usedRows,
    ...(secondaryKey ? { [secondaryKey]: tracking[secondaryKey].usedRows } : {}),
  };
  const totalAdvanced = Object.keys(cursorAfter)
    .reduce((sum, k) => sum + (cursorAfter[k] - cursorBefore[k]), 0);
  const totalAccountedFor = successful.length + duplicates.length + failed.length;
  const invariantOk = totalAdvanced === rows.length && totalAccountedFor === rows.length;

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
      requested: args.count,
      processed: rows.length,
      uploaded: successful.length,           // newly created in GHL
      skipped: duplicates.length,            // already existed; enrolled in workflow
      failed: failed.length,                 // permanent errors; logged for recovery
      invalidPhone: invalidRows.length,      // roofing-only Veriphone drops
      cursorAdvanced: totalAdvanced,
      cursorBefore,
      cursorAfter,
      invariantOk,
      durationSeconds,
    },
    successful,
    failed,
    duplicates,
    invalidPhones: invalidRows.map((r) => ({ name: r.name, phone: r.phone, reason: r._invalidReason })),
  };

  fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));

  console.log('');
  console.log('Upload complete.');
  console.log(`  Requested:        ${args.count}`);
  console.log(`  Processed:        ${rows.length}`);
  console.log(`  Newly created:    ${successful.length}`);
  console.log(`  Already in GHL:   ${duplicates.length}  (existing contacts enrolled in workflow)`);
  console.log(`  Failed:           ${failed.length}  (logged for recovery)`);
  console.log(`  Invalid phones:   ${invalidRows.length}  (Veriphone, roofing only)`);
  console.log(`  Cursor advanced:  ${totalAdvanced}`);
  console.log(`  Time taken:       ${formatDuration(durationSeconds)}`);

  if (!invariantOk) {
    console.error('');
    console.error('!!! INVARIANT VIOLATION !!!');
    console.error(`  rows.length=${rows.length}, cursor advanced by ${totalAdvanced}, accounted for ${totalAccountedFor}`);
    console.error(`  cursorBefore: ${JSON.stringify(cursorBefore)}`);
    console.error(`  cursorAfter:  ${JSON.stringify(cursorAfter)}`);
    console.error('  These MUST be equal. Tracking may be corrupted — investigate before next upload.');
    process.exit(2);
  }
  console.log(`Log saved to: data/logs/${logFilename}`);
  console.log('');
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
