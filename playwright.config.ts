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
  'jasec-dev': 'https://core-ui.jasec-dev.embrix.org/',
};

const GraphQL_URLS: Record<string, string> = {
  'coopeg-sandbox': 'https://transactional.coopeg.embrix.org/graphql',
  'jasec-dev': 'https://service-transactional.jasec-dev.embrix.org/graphql',
};

const CRM_GATEWAY_URLS: Record<string, string> = {
  'coopeg-sandbox': 'https://crm-gateway.coopegsbx.embrix.org',
  'jasec-dev': 'https://crm-gateway.jasec-dev.embrix.org',
};

const baseURL = process.env.EMBRIX_BASE_URL ?? BASE_URLS[ENV] ?? BASE_URLS['coopeg-sandbox'];

// Expose env vars for helper classes
process.env.GRAPH_URLS = process.env.EMBRIX_GRAPHQL_URL ?? GraphQL_URLS[ENV] ?? GraphQL_URLS['coopeg-sandbox'];
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
        '**/regression/embrixPlatform/*.spec.ts'
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
