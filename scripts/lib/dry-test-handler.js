// scripts/lib/dry-test-handler.js
//
// Pure-ish helpers used by discord-bot.js for the dry-test flow.
// Discord client wiring stays in the bot file; the file/IO logic
// lives here so it's testable without mocking discord.js.
//
// The dry-test flow: laptop bot receives `onboard dry test pinnacle
// <location_id>` in the dedicated #dry-test channel, parses + validates
// the location_id, pre-writes onboarding.json + meta-config.json with
// hardcoded dry-test overrides (Meta IDs, phone, domain, dry_test flag),
// then runs the orchestrator. Phase 1 still parses the operator's two
// "dry test roofing" emails to fill the email-parseable fields; the
// hand-fixed values survive the merge.

const fs = require('fs');
const path = require('path');

// Hardcoded dry-test Meta entities — operator's dedicated test ad account/page.
const DRY_TEST_AD_ACCOUNT = 'act_1515488713479185';
const DRY_TEST_PAGE_ID = '834264503095493';
const DRY_TEST_PHONE = '+15555550100';
const DRY_TEST_DOMAIN = 'https://detail.direct/contact';

const TRIGGER_RE = /^onboard\s+dry\s+test\s+pinnacle\s+(\S+)\s*$/i;
const LOCATION_ID_RE = /^[A-Za-z0-9_-]+$/;

function parseDryTestTrigger(content) {
  const m = content.trim().match(TRIGGER_RE);
  if (!m) return { ok: false };
  const location_id = m[1];
  if (!LOCATION_ID_RE.test(location_id)) {
    return { ok: false, error: 'invalid location_id format' };
  }
  return { ok: true, location_id };
}

function prepareDryTestProfile({ slug, location_id, dataDir }) {
  const clientDir = path.join(dataDir, 'clients', slug);
  const assetsDir = path.join(clientDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  // onboarding.json — hardcoded dry-test overrides + blank email-parseable
  // fields. Phase 1's email parser fills the blanks from the operator's
  // pre-sent "dry test roofing" emails; the hand-fixed values (Meta IDs,
  // phone, domain, dry_test flag) survive the merge by the existing
  // "later side wins, empty values never clobber populated ones" rule.
  const onboarding = {
    location_id,
    phone_number: DRY_TEST_PHONE,
    client_domain: DRY_TEST_DOMAIN,
    dry_test: true,
    client_business_name: '',
    client_full_name: '',
    client_location: '',
    zip_codes: [],
    client_lead_contact_email: '',
    client_lead_scheduling_email: '',
    client_personal_email: '',
  };
  fs.writeFileSync(
    path.join(clientDir, 'onboarding.json'),
    JSON.stringify(onboarding, null, 2)
  );

  // meta-config.json — dry-test ad account + page baked in.
  // pixel_id is the canonical field Phase 11 reads (NOT fb_pixel_id).
  // Empty pixel_id triggers Phase 11's pixel guard: it warns + switches
  // optimization_goal to LINK_CLICKS instead of OFFSITE_CONVERSIONS.
  const metaConfig = {
    ad_account_id: DRY_TEST_AD_ACCOUNT,
    page_id: DRY_TEST_PAGE_ID,
    pixel_id: '',
    fb_pixel_access_token: '',
  };
  fs.writeFileSync(
    path.join(clientDir, 'meta-config.json'),
    JSON.stringify(metaConfig, null, 2)
  );

  return { clientDir, assetsDir };
}

function resetDryTest({ slug, dataDir }) {
  const dir = path.join(dataDir, 'clients', slug);
  if (!fs.existsSync(dir)) return { wiped: false };
  fs.rmSync(dir, { recursive: true, force: true });
  return { wiped: true };
}

module.exports = {
  parseDryTestTrigger,
  prepareDryTestProfile,
  resetDryTest,
  DRY_TEST_AD_ACCOUNT,
  DRY_TEST_PAGE_ID,
  DRY_TEST_PHONE,
  DRY_TEST_DOMAIN,
};
