/**
 * EXPLORE — what the Core UI actually exposes, screen by screen.
 *
 * WHY THIS EXISTS. The suite reads a lot of its evidence from the database and
 * GraphQL. Some of that is unavoidable (a SOAP payload has no screen), but some
 * of it is only backend because nobody checked whether a screen existed. This
 * spec answers that question with evidence instead of opinion: it navigates to
 * each candidate screen and dumps what is rendered — headings, tabs, table
 * headers, the first row, and any "no records" text — to `artifacts/ui-surface/`.
 *
 * IT IS A DISCOVERY TOOL, NOT A CASE. Every screen is wrapped so a navigation
 * failure is RECORDED rather than thrown: a screen that cannot be reached is
 * itself the finding, and one unreachable screen must not hide the other four.
 * There are no assertions on content, so a green run means "the dump was taken",
 * never "the screen is correct".
 *
 * Screens under question (S1-S5 of the UI-focus audit):
 *   S1  Operations Center -> Correspondence   — is there a SENT notification log,
 *                                               or only template configuration?
 *   S2  Account Data -> Customer Activity     — already automated for CoopeG
 *                                               (accountInfoPage.navigateToCustomerActivity);
 *                                               dumped here to see its columns.
 *   S3  Job Schedule -> Statistics            — per-job run history + error text,
 *                                               which would replace a jobs_error read.
 *   S4  Order detail -> provisioning panel    — does it surface the Auth/Accion codes?
 *   S5  Account Info / Billing Profile        — is the credit profile and its
 *                                               threshold visible to an agent?
 *
 * READ-ONLY. No clock move, no billing run, no job_schedule slot, no writes.
 * Uses page-factory (not jasec-fixtures) so no CCP baseline fixture is attached
 * and the tenant clock is never touched — see the preprod incident in
 * project_jasec_local_preflight.
 *
 * Tester: Anh Tran (QC)
 */
import { test } from '../../../../fixtures/page-factory';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/** An account and an order that exist on dev and were created by this suite. */
const ACCOUNT = process.env.JASEC_UI_SURFACE_ACCOUNT ?? 'ACT-100857';
const ORDER = process.env.JASEC_UI_SURFACE_ORDER ?? 'ORD-1563';

const OUT_DIR = path.join('artifacts', 'ui-surface');

/** Cap every list so a huge screen cannot produce an unreadable dump. */
const CAP = 40;

function write(label: string, body: string): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${label}.txt`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/**
 * Dump the rendered surface of whatever is currently on screen.
 *
 * Deliberately generic: it does not know which screen it is looking at, so the
 * same function can be pointed at any of them and the dumps stay comparable.
 */
async function dumpScreen(page: Page, label: string, note: string): Promise<string> {
  const lines: string[] = [`# ${label}`, `# ${note}`, ''];
  const push = (k: string, v: unknown) => lines.push(`${k}: ${JSON.stringify(v)}`);

  push('url', page.url());
  push('title', await page.title().catch(() => '(none)'));

  const texts = async (sel: string) =>
    (await page.locator(sel).allInnerTexts().catch(() => []))
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, CAP);

  push('headings', await texts('h1, h2, h3, h4'));
  push('buttons', await texts('button'));
  push('tabs(role=tab)', await texts('[role="tab"]'));
  push('links', await texts('a'));

  // "no data" is a real answer — a screen that exists but is empty is not the
  // same as a screen that does not exist.
  const empty = await texts(
    'text=/no records|no data|not found|sin registros|nothing to show/i',
  );
  push('emptyStateText', empty);

  const tables = page.locator('table');
  const nTables = await tables.count().catch(() => 0);
  push('tableCount', nTables);
  for (let i = 0; i < Math.min(nTables, 6); i += 1) {
    const t = tables.nth(i);
    const headers = (await t.locator('thead th').allInnerTexts().catch(() => []))
      .map((h) => h.replace(/\s+/g, ' ').trim());
    const rows = t.locator('tbody tr');
    const nRows = await rows.count().catch(() => 0);
    const first = nRows
      ? (await rows.first().locator('td').allInnerTexts().catch(() => []))
          .map((c) => c.replace(/\s+/g, ' ').trim())
      : [];
    lines.push(`table[${i}].headers: ${JSON.stringify(headers.slice(0, CAP))}`);
    lines.push(`table[${i}].rowCount: ${nRows}`);
    lines.push(`table[${i}].firstRow: ${JSON.stringify(first.slice(0, CAP))}`);
  }

  // Cards, because not every list is a table: the job chain renders as `.card`
  // elements with an h6 title, which is why tableCount is 0 on Job Schedule.
  const cards = (await page.locator('.card').allInnerTexts().catch(() => []))
    .map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 220))
    .filter(Boolean)
    .slice(0, CAP);
  push('cards', cards);

  // Form fields tell us what an agent can see even when there is no table.
  const labels = await texts('label');
  push('labels', labels);

  const body = lines.join('\n') + '\n';
  const file = write(label, body);
  console.log(`\n[S] ${label} -> ${file}`);
  console.log(`    url=${page.url()}`);
  console.log(`    headings=${JSON.stringify((await texts('h1, h2, h3, h4')).slice(0, 6))}`);
  console.log(`    tables=${nTables} tabs=${JSON.stringify(await texts('[role="tab"]'))}`);
  if (empty.length) console.log(`    EMPTY STATE: ${JSON.stringify(empty.slice(0, 3))}`);
  return body;
}

/** Record a failure as data. An unreachable screen is a finding, not an error. */
async function safely(page: Page, label: string, note: string, go: () => Promise<void>) {
  try {
    // LOAD THE APP FIRST. Every page object's navigateViaNav() hovers a nav
    // button with a 5s wait and assumes the shell is already rendered. Without
    // this the context starts on about:blank and all five screens fail
    // identically with "locator.waitFor: Timeout 5000ms exceeded", which reads
    // like five broken screens rather than one missing step. `navigateToHome` is
    // the page extension page-factory adds; explore-01-invoice-document calls it
    // before navigateViaNav for the same reason.
    await page.navigateToHome();
    await go();
    await dumpScreen(page, label, note);
  } catch (e) {
    const msg = (e as Error).message?.split('\n').slice(0, 6).join('\n');
    write(label, `# ${label}\n# ${note}\n\nUNREACHABLE\n\n${msg}\n`);
    console.log(`\n[S] ${label} -> UNREACHABLE: ${msg?.split('\n')[0]}`);
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${label}.png`), fullPage: true })
    .catch(() => undefined);
}

test.describe('EXPLORE — Core UI surface for screens the suite currently reads from the backend', () => {
  test.describe.configure({ mode: 'serial' });

  test('S1 — Operations Center > Correspondence: template config, or a sent log?', async ({
    page, corrspondencePage,
  }) => {
    await safely(page, 'S1-correspondence',
      'Looking for a SENT notification log per account. If only template config exists, '
      + 'notification content must stay a database read.',
      async () => { await corrspondencePage.navigateViaNav(); });
  });

  test('S2 — Account Data > Customer Activity: what columns does the audit trail carry?', async ({
    page, customerManagementPage, accountInfoPage,
  }) => {
    await safely(page, 'S2-customer-activity',
      `Audit trail for ${ACCOUNT}. Already automated for CoopeG; dumped to see whether `
      + 'notification / suspension / top-up effects are visible here.',
      async () => {
        await customerManagementPage.navigateViaNav();
        await customerManagementPage.searchByAccountId(ACCOUNT);
        // The grid column is "ACCT No" — "Account Id" does not exist and the
        // TableComponent throws listing the real headers, which is how this was
        // found. Do not "correct" this back to Account Id.
        await customerManagementPage.clickFirstRowLink('ACCT No');
        await accountInfoPage.navigateToCustomerActivity();
      });
  });

  test('S3 — Job Schedule: is per-job status and error text on screen?', async ({
    page, dailySchedulePage,
  }) => {
    await safely(page, 'S3-job-schedule',
      'Looking for a per-job status (BILL_CHECK=COMPLETED/ERROR) and its error text, '
      + 'which would replace the core_engine.jobs_error read in ts-06-billing-run.',
      async () => { await dailySchedulePage.navigateViaNav(); });

    // Prove the reader built from this dump actually parses the cards. This is
    // the UI equivalent of ts-06-billing-run's `job chain = BILL_CHECK=COMPLETED|...`
    // database read, and it must be verified HERE, read-only, because the only
    // other caller bills a real account and cannot be re-run casually.
    const statuses = await dailySchedulePage.jobStatuses().catch(() => ({}));
    console.log(`\n[S] S3c-jobStatuses() -> ${JSON.stringify(statuses)}`);
    console.log(`    parsed ${Object.keys(statuses).length} job(s) from the cards`);
    write('S3c-job-statuses', `# jobStatuses() parsed output\n\n${JSON.stringify(statuses, null, 2)}\n`);

    // The chain renders one `.card` per job, each with its own Stats button.
    // Open the first one: if it carries run history and an error message, it can
    // replace the core_engine.jobs_error read.
    await safely(page, 'S3b-job-stats',
      'The per-job Stats dialog — does it carry run history and the failure reason?',
      async () => {
        await dailySchedulePage.navigateViaNav();
        await page.getByRole('button', { name: /^Stats$/ }).first().click();
        await page.waitForTimeout(2000);
      });
  });

  test('S4 — Order detail: does it surface the provisioning Auth / Accion codes?', async ({
    page, orderManagementPage,
  }) => {
    await safely(page, 'S4-order-provisioning',
      `Order ${ORDER}. Looking for provisioning status and the Auth/Accion codes that `
      + 'provisioning/dispatch and outbound-contract currently read from the database.',
      async () => {
        // NOT orderManagementPage.searchByOrderId — that drives the "Select
        // Order" MODAL used by the reference-order flow, so it waits on an input
        // that is not on screen and times out after 10s. The order detail page
        // has its own route, logged by ts-01 when it creates the order.
        await page.goto(`/orders/${ORDER}/detail`);
        await page.waitForLoadState('networkidle');
      });
  });

  test('S5 — Billing Profile: is the credit profile and its threshold visible?', async ({
    page, customerManagementPage, accountInfoPage,
  }) => {
    await safely(page, 'S5-billing-profile',
      `Billing profile for ${ACCOUNT}. Looking for the credit profile and its `
      + 'valuethreshold — the field behind the credit-profile gap defect.',
      async () => {
        await customerManagementPage.navigateViaNav();
        await customerManagementPage.searchByAccountId(ACCOUNT);
        await customerManagementPage.clickFirstRowLink('ACCT No');
        await accountInfoPage.navigateToBillingProfile();
      });
  });
});
