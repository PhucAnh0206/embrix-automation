import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as Timeouts from './helpers/timeouts.helper';

dotenv.config();

// Clear logs if configured, and ensure we only run this once in the main test runner process
if (!process.env.TEST_WORKER_INDEX && process.env.CLEAN_LOGS_ON_START === 'true') {
  const dir = path.join(process.cwd(), 'test-results', 'logs');
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(dir, file));
      } catch (err) {
        console.error(`Failed to delete log file ${file}:`, err);
      }
    }
  }
}

const ENV = process.env.TEST_ENV ?? 'sandbox';

const BASE_URLS: Record<string, string> = {
  'coopeg-sandbox': 'https://coreui.coopeg.embrix.org/',
  'embrix-sandbox': 'https://core-ui.congero.embrix.org/',
  'congero-sandbox': 'http://embrix.157.151.130.59.nip.io/',
  'jasec-dev': 'https://core-ui.jasec-dev.embrix.org/',
  'jasec-preprod': 'https://core-ui.jasec-preprod.embrix.org/',
};

const GraphQL_URLS: Record<string, string> = {
  'coopeg-sandbox': 'https://transactional.coopeg.embrix.org/graphql',
  'embrix-sandbox': 'https://service-transactional.congero.embrix.org/graphql',
  'congero-sandbox': 'http://graphiql.embrix.157.151.130.59.nip.io/graphiql',
  'jasec-dev': 'https://service-transactional.jasec-dev.embrix.org/graphql',
  'jasec-preprod': 'https://service-transactional.jasec-preprod.embrix.org/graphql',
};

const CRM_GATEWAY_URLS: Record<string, string> = {
  'coopeg-sandbox': 'https://crm-gateway.coopegsbx.embrix.org',
  'jasec-dev': 'https://crm-gateway.jasec-dev.embrix.org',
  'jasec-preprod': 'https://crm-gateway.jasec-preprod.embrix.org',
};

const baseURL = process.env.EMBRIX_BASE_URL ?? BASE_URLS[ENV] ?? BASE_URLS['coopeg-sandbox'];

// Expose env vars for helper classes
process.env.GRAPH_URLS = process.env.EMBRIX_GRAPHQL_URL ?? GraphQL_URLS[ENV] ?? GraphQL_URLS['coopeg-sandbox'];

// ── JEPYP-230 live-run gate ────────────────────────────────────────────────
// The live notification suite moves the tenant-global CCP clock and spends a
// job_schedule slot, so it must only fire when asked for BY NAME. This detection
// has to live HERE, in the main process: a spec sees the WORKER's process.argv,
// which does not carry --project, so gating inside the spec always reads false
// and silently skips. Workers inherit this env var (same mechanism as
// GRAPH_URLS above), so the spec reads it correctly.
if (process.argv.join(' ').includes('jasec-notification-live')) {
  process.env.JEPYP230_LIVE_RUN = 'true';
}
// TS-05 (tier boundaries) needs the SAME protection for the same reason, and for a
// while did not have it: it calls setAndVerifyCcpTime and creates a schedule, so a
// bare `npx playwright test` — which runs every project — would move the shared
// clock (potentially BACKWARD, e.g. from 2027-11-09 to its 2026-11-09 default) and
// spend a slot. Gated separately from the live run so naming one project does not
// silently enable the other; they must never share a date.
if (process.argv.join(' ').includes('jasec-notification-tiers')) {
  process.env.JEPYP230_TIER_RUN = 'true';
}
process.env.CRM_GATEWAY_URL = process.env.EMBRIX_CRM_GATEWAY_URL ?? CRM_GATEWAY_URLS[ENV] ?? CRM_GATEWAY_URLS['coopeg-sandbox'];

export default defineConfig({
  testDir: './tests',

  /* Run tests in each file sequentially — Embrix tests share state (billing cycles, accounts) */
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,

  /* Timeouts */
  timeout: 600_000,
  expect: { timeout: Timeouts.LONG_WAIT },

  /* Reporters */
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    ['list'],
  ],

  /* Shared settings for all projects */
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: Timeouts.LONG_WAIT,
    navigationTimeout: Timeouts.EXTRA_LONG_WAIT,
    launchOptions: {
      args: ['--disable-web-security'],
    },
  },

  projects: [
    // ── Auth Setup: Login once, save storageState ──────────────────────
    {
      name: 'setup',
      testMatch: '**/auth.setup.ts',
      use: { ...devices['Desktop Chrome'] },
    },

    // ── Unit: pure helper logic, no browser / VPN / mailbox ───────────
    {
      name: 'unit',
      testMatch: '**/unit/*.spec.ts',
    },

    // ── Smoke Tests: Quick health-check (no auth dependency) ───────────
    {
      name: 'smoke',
      testMatch: '**/smoke/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },

    // ── Regression: (reuse saved session) ─────────────
    {
      name: 'regression',
      testMatch: [
        '**/regression/embrixPlatform/*.spec.ts',
        '**/regression/coopeguanacaste/*.spec.ts',
      ],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── JASEC regression: prepaid account creation + JASEC-specific flows
    {
      name: 'jasec-regression',
      testMatch: ['**/regression/jasec/*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── JASEC notification: JEPYP-230 email template content checks.
    // Separate project because these wait on real mail delivery (slow) and
    // need NOTIFY_* env the other suites do not.
    {
      name: 'jasec-notification',
      // ts-01 only. Its siblings in this folder are separate projects — see below.
      testMatch: ['**/regression/jasec/notification/ts-01-*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── JASEC notification content: replays rendered bodies out of
    // core_engine.email_notification and asserts them against the templates.
    // DB only — no browser, no mailbox, no `setup` dependency, so it needs
    // neither UI auth nor a billing run and is safe to run at any time.
    {
      name: 'jasec-notification-content',
      testMatch: ['**/regression/jasec/notification/ts-03-*.spec.ts'],
    },

    // ── JASEC notification live run: stages balance bands, fires a billing
    // schedule, asserts all seven events. IRREVERSIBLE — moves the tenant CCP
    // clock forward and spends a job_schedule slot. Gated behind
    // JEPYP230_LIVE_RUN=true inside the spec; skips without it.
    {
      name: 'jasec-notification-live',
      testMatch: ['**/regression/jasec/notification/ts-02-*.spec.ts'],
    },

    // ── JASEC notification reconnection: Event 6 (report cases 5.2 / 5.3).
    // Needs a browser because there is no top-up API — top-up is Selfcare UI only.
    // Consumes one suspended account per run (leaves it ACTIVE and in credit,
    // which is the correct end state), so it is its own project rather than part
    // of the read-only content suite.
    {
      name: 'jasec-notification-reconnect',
      testMatch: ['**/regression/jasec/notification/ts-04-*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── JASEC notification tier boundaries: JEPYP-230 cases 3.7 / 3.8 / 3.9.
    // No browser — DB staging plus a GraphQL billing run. It DOES move the CCP
    // clock and DOES write to the DB, so it is deliberately its own project
    // rather than part of the read-only content suite.
    {
      name: 'jasec-notification-tiers',
      testMatch: ['**/regression/jasec/notification/ts-05-*.spec.ts'],
    },

    // ── JASEC billing EXPLORATORY: the invoice as a DOCUMENT, read through Core UI.
    // NOT PART OF THE OFFICIAL SUITE. There is no EPDP sub-task for billing or
    // invoicing; this project exists to find out whether the area is worth
    // covering. Its specs are named `explore-*`, carry no TC numbers, and are not
    // listed in EPDP-348_JASEC-Test\INDEX.md as cases.
    // Background: JEPYP-230 report case 7.3 — "matches what Core UI shows" needs
    // the UI to be the other half of the comparison, so it needs a browser.
    // READ-ONLY: opens an existing invoice. No clock move, no billing run, no
    // job_schedule slot, so unlike the -live project it is safe at any time.
    {
      // One folder, two projects, split by filename prefix: `explore-*` needs a
      // browser and the VPN, `read-*` needs neither. Keep the prefixes.
      name: 'jasec-billing-explore',
      testMatch: ['**/regression/jasec/billing/explore-*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── JASEC billing READ: the invoice and the account statement as records,
    // read over GraphQL. Shares the `billing/` folder with the explore spike and
    // is separated by the `read-` filename prefix, NOT by directory.
    //
    // No browser, no `setup` dependency, no DB and therefore NO VPN — unlike
    // `jasec-billing-explore` (needs a browser to compare against Core UI) and
    // unlike `jasec-notification-content` (reads the database). Entirely
    // read-only: no clock move, no job_schedule slot, no staged account, so it is
    // safe to run at any time and from CI.
    // Cases here carry no TC number on purpose — numbering is assigned from the
    // EPDP-348 sub-task list once a proposal is accepted.
    {
      name: 'jasec-billing-read',
      testMatch: ['**/regression/jasec/billing/read-*.spec.ts'],
    },

    // ── JASEC top-up: Self Care card mgmt, top-up, Min Amount business logic
    {
      name: 'jasec-top-up',
      testMatch: ['**/regression/jasec/top-up/*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },
  ],
});
