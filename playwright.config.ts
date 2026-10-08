import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as Timeouts from './helpers/timeouts.helper';
import { resolveTenant, assertSuiteAllowed, isSuiteAllowed, requestedProjects } from './config/tenants';

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

// ── Tenant resolution ──────────────────────────────────────────────────────
// One tenant per run, named by TEST_ENV and validated against the registry in
// config/tenants.ts. There is no fallback: the old resolution silently used
// CoopeG when it could not work out the target, which is how a preprod run
// once raised an order on dev.
const { name: TENANT_NAME, tenant: TENANT } = resolveTenant();

const baseURL = TENANT.baseUrl;

// Exposed for helper classes, which read these rather than the registry.
process.env.TEST_ENV = TENANT_NAME;
process.env.EMBRIX_BASE_URL = TENANT.baseUrl;
process.env.GRAPH_URLS = TENANT.graphqlUrl;
process.env.EMBRIX_GRAPHQL_URL = TENANT.graphqlUrl;
if (TENANT.selfcareUrl) process.env.SELFCARE_BASE_URL = TENANT.selfcareUrl;
if (TENANT.crmGatewayUrl) process.env.CRM_GATEWAY_URL = TENANT.crmGatewayUrl;

// Refuse a suite that does not belong to this tenant, before a browser opens.
// Both `--project=X` and `--project X` are read - the space form used to slip
// past this check entirely.
for (const project of requestedProjects(process.argv)) {
  assertSuiteAllowed(project, TENANT_NAME);
}

// Workers re-evaluate this file, so print once from the runner only.
if (!process.env.TEST_WORKER_INDEX) {
  console.log(`[tenant] ${TENANT_NAME} -> ${TENANT.baseUrl}`);
  if (TENANT.note) console.log(`[tenant] note: ${TENANT.note}`);
}

if (process.argv.join(' ').includes('jasec-notification-live')) {
  process.env.JEPYP230_LIVE_RUN = 'true';
}
if (process.argv.join(' ').includes('jasec-notification-tiers')) {
  process.env.JEPYP230_TIER_RUN = 'true';
}

export default defineConfig({
  testDir: './tests',

  /* Run tests in each file sequentially — Embrix tests share state (billing cycles, accounts) */
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  /**
   * PW_RETRIES lets a long local sweep survive the known Core UI load timeout
   * without turning retries on for ordinary runs.
   *
   * `page.goto` to the Core UI root times out at 180s under repeated loads —
   * ~17.7MB of uncompressed bundle per load, gzip off, documented and not a
   * product defect. It costs nothing in a single run, but Block E invokes ts-01
   * sixteen times back to back and on 2026-09-24 that timeout blocked ten
   * rating cases that had nothing wrong with them.
   *
   * Default is unchanged (0 locally, 2 on CI), so this is inert unless set.
   */
  retries: Number(process.env.PW_RETRIES ?? (process.env.CI ? 2 : 0)),
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
    /**
     * PW_NAV_TIMEOUT raises the navigation budget for a run over a degraded
     * link, without changing it for anyone else.
     *
     * The first page.goto of a test pulls the whole Core UI bundle; later
     * navigations in the same context are served from the browser cache, so it
     * is only ever the first one that is at risk. On a healthy link that is
     * seconds. On 2026-09-24 the VPN degraded to ~93 KB/s, which puts one load
     * at roughly 190s against this 180s ceiling - marginal, and it lost, taking
     * Block B down at navigation before it reached a single assertion.
     *
     * Raising the ceiling is the honest accommodation here, unlike retries,
     * which multiply the download instead of allowing for it. Default unchanged.
     */
    navigationTimeout: Number(process.env.PW_NAV_TIMEOUT ?? Timeouts.EXTRA_LONG_WAIT),
    /**
     * PW_DISK_CACHE gives the browser a persistent HTTP cache for the run.
     *
     * Playwright makes a fresh CONTEXT per test, and a fresh context has an
     * empty cache — so every invocation of ts-01 re-downloads the whole Core UI
     * bundle. Block E runs ts-01 sixteen times, which on 2026-09-24's degraded
     * link (~93 KB/s, one chunk alone 6.19MB = 67s) was most of the wall clock
     * and the direct cause of cases blocking at navigation.
     *
     * The browser PROCESS is reused across tests in a worker, and
     * --disk-cache-dir is a launch flag, so the cache outlives the context:
     * download once per run instead of once per test.
     *
     * THIS IS NOT A SHORTCUT — it honours what the server already asks for:
     *
     *   /                          no-store, no-cache, must-revalidate
     *   /env-config.js             no-store, no-cache, must-revalidate
     *   /static/js/*.chunk.js      public, max-age=31536000, immutable
     *
     * The bundles are declared immutable and cacheable for a year, and the HTML
     * and runtime config are declared never-cacheable. A real user's browser
     * behaves exactly this way; a cold cache on every test is the unrealistic
     * setting. Staleness cannot hide a deploy either: the bundles are
     * content-hashed, so a new build is a new URL and misses the cache, and
     * env-config.js is never served from it.
     *
     * Off by default so ordinary runs are untouched.
     */
    launchOptions: {
      args: [
        '--disable-web-security',
        ...(process.env.PW_DISK_CACHE
          ? [`--disk-cache-dir=${process.env.PW_DISK_CACHE}`, '--disk-cache-size=536870912']
          : []),
      ],
    },
  },

  // A run with no --project (`npm test`, `--ui`, a bare spec path) used to get
  // EVERY project, so the JASEC suites ran against CoopeG and vice versa. Such
  // runs are legitimate, so they are not refused; the projects that do not
  // belong to this tenant are simply not offered.
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
      // ts-02 — the 41-case Embrix platform suite. Runs on any tenant that
      // carries a normal catalog.
      name: 'embrix-platform',
      testMatch: ['**/regression/embrixPlatform/*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    {
      // ts-01 — the CoopeG full-lifecycle suite (account -> provisioning ->
      // billing -> collections). Split out of the old single `regression`
      // project: both lived under one name, so `--project=regression` without a
      // spec path silently ran this one too, with its billing jobs and extra
      // clock moves.
      name: 'coopeg-lifecycle',
      testMatch: ['**/regression/coopeguanacaste/*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── Dev: documentation / scratch specs. NOT part of regression ────
    // `read-context.spec.ts` demonstrates the test-context helper by writing
    // placeholder ids (INV-FIXTURE-67890, INV-DIRECT-12345). While it lived
    // under regression/coopeguanacaste it ran on every regression pass and
    // wrote those fakes into the then-shared context file, which other suites
    // read back as real data. Keep demo specs out of `regression`.
    {
      name: 'dev',
      testMatch: ['**/dev/*.spec.ts'],
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

    // ── JASEC provisioning (JEPYP-27): suspend/reconnect, both directions plus
    // the config they depend on. One project so the whole flow runs from one
    // command instead of half here and half over ssh.
    //
    //   inbound-contract   our updateProvisioningRequest endpoint. Every case is
    //                      a REFUSAL, so it needs no fixture and touches
    //                      nothing: each payload names either an order id that
    //                      cannot exist or ORD-960, which is COMPLETED and
    //                      terminal. No browser, no DB, no auth, no VPN.
    //   outbound-contract  the payload contract, the template, the gateway
    //                      config and the current order state. Read only, every
    //                      statement a SELECT. NEEDS THE VPN - if the database
    //                      is unreachable every case SKIPS with the reason
    //                      printed, because a dropped VPN is an unmet
    //                      precondition and not a defect.
    //   dispatch           builds and sends a real command: the reconnect
    //                      payload, the retry interval and the batch size.
    //                      REACHES JASEC'S LIVE AMI, so it is gated behind
    //                      JASEC_DISPATCH_RUN and skips on a normal run. Its
    //                      guard excludes any meter JASEC has ever answered 00
    //                      for, so it cannot consume an order staged for a
    //                      session.
    //
    // The happy paths are NOT here and cannot be: closing an order needs one in
    // PROVISIONING_INITIATED, which only exists once JASEC accept a dispatched
    // command on a meter they recognise, and dispatching consumes the single
    // meter they have released.
    // suspend-resume-orders, reprocess-failed-step and auto-suspend-resume are excluded here and run in
    // jasec-provisioning-orders below, because they need a browser and a logged-in session and these do not.
    {
      name: 'jasec-provisioning',
      testMatch: ['**/regression/jasec/provisioning/*.spec.ts'],
      testIgnore: ['**/regression/jasec/provisioning/suspend-resume-orders.spec.ts', '**/regression/jasec/provisioning/reprocess-failed-step.spec.ts', '**/regression/jasec/provisioning/auto-suspend-resume.spec.ts'],
    },

    // ── JASEC provisioning through the Core UI.
    //
    // reprocess-failed-step: the "Submit order" button on the order detail page, which is
    // the manual reprocess the ticket asks for ("the UI need to be able to
    // reprocess manually"). The UI path is a strict superset of the API one -
    // button, mutation, OMS queue, sequence re-run, dispatch - so this is the
    // only test for that requirement rather than one of a pair.
    //
    // auto-suspend-resume: the AUTOMATIC suspend/resume (breach / top-up), checked on the
    // Services, order detail and Customer Activity screens as well as in the database.
    //
    // suspend-resume-orders: SUSPEND and RESUME raised from the Suspend Order /
    // Resume Order screens - the order shape production creates (no service
    // line) - plus an API-built control. Gated behind JASEC_SUSPEND_ORDERS_RUN;
    // run one tag at a time (@order-journey, @resume-billing-only-suspend, @resume-existing-suspension, @api-control).
    //
    // Needs a browser, a session and therefore the VPN. Each spec carries its OWN
    // run gate on top of that, because they dispatch to JASEC's live AMI:
    // suspend-resume-orders JASEC_SUSPEND_ORDERS_RUN, reprocess-failed-step
    // JASEC_REPROCESS_RUN, auto-suspend-resume JASEC_AUTO_PROV_RUN (plus
    // JASEC_HELD_CYCLE_RUN for @auto-held-cycle).
    {
      name: 'jasec-provisioning-orders',
      testMatch: ['**/regression/jasec/provisioning/suspend-resume-orders.spec.ts', '**/regression/jasec/provisioning/reprocess-failed-step.spec.ts', '**/regression/jasec/provisioning/auto-suspend-resume.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── JASEC billing via the Core UI Daily Schedule screen.
    // Proves the UI can run a billing cycle. The GraphQL path in ts-02 / ts-05
    // stays the one the suite relies on; this is an addition so a UI regression
    // cannot stop the regression suite from billing.
    //
    // IRREVERSIBLE: moves the tenant CCP clock, spends a job_schedule slot, and
    // bills real accounts (advancing their cycle). Gates live inside each spec
    // and differ: ts-06 needs JASEC_BILL_RUN=true and refuses to start without an
    // explicit JASEC_BILL_DATE; ts-08 is gated on JASEC_TOPUP_RUN; ts-07 has NO
    // run gate - naming this project runs it.
    // Needs a browser and the DB, therefore the VPN.
    {
      name: 'jasec-billing-run',
      testMatch: [
        '**/regression/jasec/billing/ts-06-*.spec.ts',
        '**/regression/jasec/billing/ts-07-*.spec.ts',
        '**/regression/jasec/billing/ts-08-*.spec.ts',
      ],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
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
    // ── BILLING FILE NUMBERS ARE LOAD-BEARING ────────────────────────────
    // Renamed 2026-09-11 from read-* / ui-* to the ts-NN-* convention the rest
    // of the suite uses. The prefix used to say what a spec needed; now the
    // NUMBER does, and nothing in the filename warns you any more:
    //
    //   ts-06 .. ts-08   MUTATING    browser + DB + VPN, bills REAL accounts
    //                                irreversibly, needs a private BDOM.
    //                                THIS BAND IS RESERVED - do not reuse it.
    //   every other ts-NN  READ-ONLY  no browser, no DB, no VPN, safe in CI
    //                                (today: ts-01..ts-05, ts-09)
    //   explore-NN       spike, not official coverage
    //
    // So a new billing spec must be numbered into the right range, not just
    // appended. Putting a mutating spec at ts-04 would silently place it in the
    // read-only project, which runs inside `-Block all`.
      name: 'jasec-billing-read',
      testMatch: [
        '**/regression/jasec/billing/ts-01-*.spec.ts',
        '**/regression/jasec/billing/ts-02-*.spec.ts',
        '**/regression/jasec/billing/ts-03-*.spec.ts',
        '**/regression/jasec/billing/ts-04-*.spec.ts',
        '**/regression/jasec/billing/ts-05-*.spec.ts',
        '**/regression/jasec/billing/ts-09-*.spec.ts',
      ],
    },

    // ── JASEC TC-143 on screen (read-only): the Account Statement screen shows the same ledger chain
    // ts-03 proves in the data. Browser + session, so not in jasec-billing-read ("no browser").
    //   $env:JASEC_TWO_CYCLE_ACCOUNT='<acct>'; npx playwright test --project=jasec-billing-statement
    {
      name: 'jasec-billing-statement',
      testMatch: ['**/regression/jasec/billing/ts-14-*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── JASEC TC-142 (read-only): a prepaid invoice is settled from the balance and never goes
    // to collections (Luis, 2026-10-05). Its OWN project, run AFTER the billing runs: its third
    // test judges the invoices the latest TC-139 run recorded (artifacts/billing-run-invoices.json).
    // In jasec-billing-read it would run BEFORE them and judge a stale run.
    //   npx playwright test --project=jasec-billing-settlement
    // Tests 1-2 read the database only; test 3 also opens Core UI (Bills, Account Statement), so it
    // needs the browser and the logged-in session.
    {
      name: 'jasec-billing-settlement',
      testMatch: ['**/regression/jasec/billing/ts-13-*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── JASEC ACCOUNTING: the EBS / ERP extract (point 10 of the E2E guide).
    //
    // ACCOUNTING FILE NUMBERS ARE LOAD-BEARING, exactly as in billing/:
    //
    //   ts-01 .. ts-05   READ-ONLY   no clock move, no extract run. ts-01 and
    //                                ts-02 need no browser and no VPN either;
    //                                ts-03 reads the DB, so it needs the VPN.
    //   ts-06 .. ts-08   MUTATING    RESERVED. Runs `ebsExtract`, which CONSUMES
    //                                a day's journals, flips them to POSTED and
    //                                stamps them with a batch id. There is no
    //                                un-extract. Do not reuse this band.
    //
    // A mutating spec numbered ts-04 would land silently in the read-only
    // project, which is safe to run at any time — and would then run itself.
    {
      name: 'jasec-accounting',
      testMatch: [
        '**/regression/jasec/accounting/ts-01-*.spec.ts',
        '**/regression/jasec/accounting/ts-02-*.spec.ts',
        '**/regression/jasec/accounting/ts-03-*.spec.ts',
      ],
    },

    // MUTATING half. Gated inside the spec behind JASEC_EBS_RUN=true and it
    // refuses to start without one, so a broad run can never trigger an extract.
    // Needs the DB, therefore the VPN. No browser.
    {
      name: 'jasec-accounting-run',
      testMatch: ['**/regression/jasec/accounting/ts-06-*.spec.ts'],
    },

    // ── JASEC billing TRUE-UP: the 0-30 kWh fixed charge and the cycle length
    // it depends on. MUTATING and it MOVES THE TENANT-GLOBAL CCP CLOCK, so it is
    // its own project rather than part of the ts-06..08 billing band — a clock
    // move is a heavier conflict than billing one account, and it must never be
    // picked up by a broad run. Gated inside the spec behind JASEC_TRUEUP_RUN=true.
    // Bills and invoices through the Core UI Bill Pending screen since 2026-10-06 - needs the browser + session.
    {
      name: 'jasec-billing-trueup',
      testMatch: ['**/regression/jasec/billing/ts-10-*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },
    // ── JASEC billing: several credit-limit breaches in ONE BILL_CHECK run must not
    // freeze it (preprod 2026-10-03). MUTATING, moves the CCP clock, dev only.
    // Gated inside the spec behind JASEC_BREACH_RUN=true.
    {
      name: 'jasec-billing-breach',
      testMatch: ['**/regression/jasec/billing/ts-11-*.spec.ts'],
    },
    // ── JASEC billing: a customer who saved a card and topped up with it is still
    // invoiced (JEPYP-326). MUTATING: pays with the PlaceToPay test card, moves the
    // CCP clock, bills. Gated inside the spec behind JASEC_SAVEDCARD_RUN=true.
    {
      name: 'jasec-billing-savedcard',
      testMatch: ['**/regression/jasec/billing/ts-12-*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },
    {
      // Seeding only (gated JASEC_SEED_RUN): zero-usage invoices over GraphQL.
      name: 'jasec-seed',
      testMatch: ['**/regression/jasec/seed/*.spec.ts'],
    },

    // ── JASEC USAGE: the credit breach, the parked reading and its replay.
    // MUTATING — seeds an account, drops real MDR files through the loader and
    // moves balances. Gated inside the spec behind JASEC_USAGE_RUN=true. Needs
    // SSH to the control server and the DB, therefore the VPN. Since 2026-10-06 the
    // replay is done on the Core UI Suspended/Failed Batches screen, so it needs a session.
    // ts-06+ is the mutating band here too; keep read-only usage specs at ts-01..05.
    {
      name: 'jasec-usage-run',
      testMatch: ['**/regression/jasec/usage/ts-06-*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── JASEC Block E on screen (READ-ONLY): the charges the tarification scenarios rated are shown
    // on Rated Usage with the same amounts. Reads artifacts/block-e-results.json (run-block-E.ps1 writes
    // it); run-suite -Block tarif runs this straight after Block E.
    {
      name: 'jasec-usage-charges',
      testMatch: ['**/regression/jasec/usage/ts-01-*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
    },

    // ── JASEC USAGE, through the UI: rated usage must reach the two Core UI
    // screens that display it — Billing Data > Rated Usage and > Usage Records.
    // MUTATING like -usage-run, and additionally needs a browser, so it is a
    // separate project rather than another testMatch on that one. Gated inside
    // the spec behind JASEC_USAGE_UI_RUN=true.
    {
      name: 'jasec-usage-screens',
      testMatch: ['**/regression/jasec/usage/ts-07-*.spec.ts'],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
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
  ].filter(p => isSuiteAllowed(p.name ?? '', TENANT_NAME)),
});
