/**
 * test-lead-uploader.js
 *
 * End-to-end verification test for ghl-lead-uploader.js.
 *
 * Usage:
 *   node scripts/test-lead-uploader.js \
 *     --account "coleton sub acc 1" \
 *     --workflow "boom"
 *
 * What it does:
 *   1. Creates a temporary test CSV with 3 fake contacts
 *   2. Runs the uploader against a real GHL sub-account
 *   3. Verifies the contacts exist in GHL via GET /contacts/
 *   4. Cleans up: deletes test contacts from GHL
 *   5. Removes the test CSV and tracking.json entry
 *   6. Prints PASS or FAIL
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

// ─── Constants ───────────────────────────────────────────────────────────────

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

const TEST_SERVICE = 'test';
const TEST_STATE = 'TEST';
const TEST_CSV_DIR = path.join(__dirname, '../data/leads/all_contacts_final/test');
const TEST_CSV_PATH = path.join(TEST_CSV_DIR, 'TEST.csv');
const TRACKING_FILE = path.join(__dirname, '../data/leads/tracking.json');
const SUB_ACCOUNT_TOKENS_FILE = path.join(__dirname, '../data/sub-account-tokens.json');

// 3 fake contacts — use obviously fake names + unlikely-to-collide phone numbers
const TEST_CONTACTS = [
  { name: 'Zed Tester Alpha', city: 'Testville', phone: '+19990000001' },
  { name: 'Zed Tester Beta', city: 'Faketon', phone: '+19990000002' },
  { name: 'Zed Tester Gamma', city: 'Mockburg', phone: '+19990000003' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ghlHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    'Content-Type': 'application/json',
  };
}

function log(msg) {
  console.log(`[test] ${msg}`);
}

function pass(msg) {
  console.log(`\n✓ PASS${msg ? ': ' + msg : ''}`);
}

function fail(msg) {
  console.error(`\n✗ FAIL${msg ? ': ' + msg : ''}`);
  process.exitCode = 1;
}

// ─── CLI Arg Parsing ─────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      parsed[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  if (!parsed.account || !parsed.workflow) {
    console.error('Usage: node scripts/test-lead-uploader.js --account "name" --workflow "name"');
    process.exit(1);
  }
  return parsed;
}

// ─── Sub-Account Token Lookup ────────────────────────────────────────────────

function loadSubAccountToken(locationId) {
  if (!fs.existsSync(SUB_ACCOUNT_TOKENS_FILE)) {
    console.error('Error: data/sub-account-tokens.json not found.');
    process.exit(1);
  }
  const tokens = JSON.parse(fs.readFileSync(SUB_ACCOUNT_TOKENS_FILE, 'utf8'));
  if (!tokens[locationId]) {
    console.error(`Error: No token found in data/sub-account-tokens.json for location "${locationId}".`);
    process.exit(1);
  }
  return tokens[locationId].token;
}

// ─── GHL Sub-Account Lookup (minimal, for cleanup) ───────────────────────────

async function findLocationId(token, accountName) {
  const LIMIT = 20;
  let offset = 0;
  while (true) {
    const res = await axios.get(`${GHL_BASE}/locations/search`, {
      headers: ghlHeaders(token),
      params: { limit: LIMIT, skip: offset },
    });
    const page = res.data.locations ?? res.data;
    if (!Array.isArray(page) || page.length === 0) break;
    const match = page.find((loc) => loc.name.toLowerCase().includes(accountName.toLowerCase()));
    if (match) return match.id;
    if (page.length < LIMIT) break;
    offset += LIMIT;
  }
  return null;
}

// ─── Run Uploader as Child Process ───────────────────────────────────────────

function runUploader(account, workflow) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join(__dirname, 'ghl-lead-uploader.js'),
      '--service', TEST_SERVICE,
      '--state', TEST_STATE,
      '--count', '3',
      '--account', account,
      '--workflow', workflow,
    ];

    log(`Running uploader: node ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

    const child = spawn(process.execPath, args, {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Uploader exited with code ${code}\nstderr: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ─── GHL Contact Verification ────────────────────────────────────────────────

/**
 * Fetch a single contact by ID. Returns the contact object or null if not found.
 */
async function getContactById(token, contactId) {
  try {
    const res = await axios.get(`${GHL_BASE}/contacts/${contactId}`, {
      headers: ghlHeaders(token),
    });
    return res.data.contact ?? res.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the most recent upload log file and return its parsed contents.
 */
function readLatestUploadLog() {
  const logsDir = path.join(__dirname, '../data/logs');
  if (!fs.existsSync(logsDir)) return null;
  const files = fs.readdirSync(logsDir)
    .filter((f) => f.startsWith('upload-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(logsDir, files[0]), 'utf8'));
}

// ─── GHL Contact Deletion ─────────────────────────────────────────────────────

async function deleteContact(token, contactId) {
  await axios.delete(`${GHL_BASE}/contacts/${contactId}`, {
    headers: ghlHeaders(token),
  });
}

// ─── Cleanup Helpers ─────────────────────────────────────────────────────────

function removeTestCSV() {
  if (fs.existsSync(TEST_CSV_PATH)) fs.unlinkSync(TEST_CSV_PATH);
  // Remove the test service directory if empty
  try {
    const remaining = fs.readdirSync(TEST_CSV_DIR);
    if (remaining.length === 0) fs.rmdirSync(TEST_CSV_DIR);
  } catch { /* ignore */ }
}

function removeTrackingEntry() {
  if (!fs.existsSync(TRACKING_FILE)) return;
  const tracking = JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'));
  delete tracking[`${TEST_SERVICE}/${TEST_STATE}`];
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(tracking, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const token = process.env.GHL_PRIVATE_TOKEN;

  if (!token) {
    console.error('GHL_PRIVATE_TOKEN not found in .env');
    process.exit(1);
  }

  log('Starting end-to-end test...\n');

  // ── Step 1: Create test CSV ────────────────────────────────────────────────
  log('Step 1: Creating test CSV at data/leads/all_contacts_final/test/TEST.csv');
  fs.mkdirSync(TEST_CSV_DIR, { recursive: true });
  const csvLines = ['name,city,phone,notes', ...TEST_CONTACTS.map((c) => `${c.name},${c.city},${c.phone},`)];
  fs.writeFileSync(TEST_CSV_PATH, csvLines.join('\n') + '\n');
  log(`  Created with ${TEST_CONTACTS.length} test contacts.`);

  // ── Step 2: Run uploader ───────────────────────────────────────────────────
  log('\nStep 2: Running ghl-lead-uploader.js...');
  try {
    await runUploader(args.account, args.workflow);
  } catch (err) {
    fail(`Uploader crashed: ${err.message}`);
    removeTestCSV();
    removeTrackingEntry();
    return;
  }

  // ── Step 3: Find location ID for verification ──────────────────────────────
  log('\nStep 3: Resolving GHL location ID for verification...');
  const locationId = await findLocationId(token, args.account);
  if (!locationId) {
    fail(`Could not find location for account "${args.account}"`);
    removeTestCSV();
    removeTrackingEntry();
    return;
  }
  log(`  Location ID: ${locationId}`);

  // Load the sub-account token for location-level API calls
  const subToken = loadSubAccountToken(locationId);

  // ── Step 4: Verify contacts exist in GHL ──────────────────────────────────
  log('\nStep 4: Verifying contacts were created in GHL...');

  // Parse the upload log to get the contact IDs created by the uploader
  const uploadLog = readLatestUploadLog();
  if (!uploadLog || uploadLog.summary.uploaded !== TEST_CONTACTS.length) {
    fail(`Upload log missing or incomplete. Expected ${TEST_CONTACTS.length} uploaded, got ${uploadLog?.summary?.uploaded ?? 0}.`);
    removeTestCSV();
    removeTrackingEntry();
    return;
  }

  const createdContactIds = [];
  let allFound = true;

  for (const entry of uploadLog.successful) {
    const found = await getContactById(subToken, entry.contactId);
    if (found) {
      log(`  ✓ Found: ${entry.name} (${entry.phone}) → ID: ${entry.contactId}`);
      createdContactIds.push(entry.contactId);
    } else {
      log(`  ✗ NOT FOUND: ${entry.name} (${entry.phone}) → ID: ${entry.contactId}`);
      allFound = false;
    }
  }

  // ── Step 5: Clean up contacts from GHL ────────────────────────────────────
  log('\nStep 5: Deleting test contacts from GHL...');
  for (const id of createdContactIds) {
    try {
      await deleteContact(subToken, id);
      log(`  Deleted contact ${id}`);
    } catch (err) {
      log(`  Warning: could not delete contact ${id}: ${err.message}`);
    }
  }

  // ── Step 6: Clean up local files ──────────────────────────────────────────
  log('\nStep 6: Cleaning up test CSV and tracking entry...');
  removeTestCSV();
  removeTrackingEntry();
  log('  Done.');

  // ── Result ────────────────────────────────────────────────────────────────
  if (allFound) {
    pass('All 3 test contacts were created and verified in GHL.');
  } else {
    fail('One or more test contacts were not found in GHL after upload.');
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
