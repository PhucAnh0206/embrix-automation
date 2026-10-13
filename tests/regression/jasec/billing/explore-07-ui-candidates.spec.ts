/**
 * EXPLORATORY probe - which candidate screens (V1..V14 of the 2026-10-06 UI audit) can carry a UI step.
 * Pass 1 is READ-ONLY: opens each screen for one of OUR accounts and dumps headings, form fields and grids
 * to artifacts/ui-candidates/<env>/Vn.txt (+ a screenshot). Not a case.
 *
 *   npx playwright test --project=jasec-billing-explore --grep "@ui-candidates"
 *
 * Accounts (override with env): JASEC_UIC_BILLED (billed, saved card), JASEC_UIC_SUSPENDED (suspended,
 * failed RESUME), JASEC_UIC_AUTOSUSP (automatic breach SUSPEND), JASEC_UIC_PARKED (a parked reading),
 * JASEC_UIC_ORDER (an automatic SUSPEND order id).
 */
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { DbHelper } from '../../../../helpers/db.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { AgentScreens, openAgentTab } from '../../../../helpers/agent-screens.helper';
import * as fs from 'fs';
import * as path from 'path';
import { attachToAccountInSelfCare } from '../../../../fixtures/create-prepaid-account.helper';

const ENV = process.env.TEST_ENV ?? 'unknown';
const OUT = path.join('artifacts', 'ui-candidates', ENV);
const A = {
  billed: process.env.JASEC_UIC_BILLED ?? 'ACT-100131',
  suspended: process.env.JASEC_UIC_SUSPENDED ?? 'ACT-100127',
  autoSusp: process.env.JASEC_UIC_AUTOSUSP ?? 'ACT-100128',
  parked: process.env.JASEC_UIC_PARKED ?? 'ACT-100020',
  order: process.env.JASEC_UIC_ORDER ?? 'ORD-225',
  resumeOrder: process.env.JASEC_UIC_RESUME_ORDER ?? 'ORD-221',
};

async function dump(page: any, id: string, label: string): Promise<void> {
  await page.waitForTimeout(3500);
  const data = await page.evaluate(() => {
    const t = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5')).map(t).filter(Boolean);
    const fields: string[] = [];
    document.querySelectorAll('.form-group, .select-group').forEach(g => {
      const lab = t(g.querySelector('label'));
      const inp = g.querySelector('input, textarea') as HTMLInputElement | null;
      const sel = g.querySelector('[class*="single-value"]');
      const val = sel ? t(sel) : (inp ? inp.value : '');
      if (lab) fields.push(`${lab} = ${val}`);
    });
    const tables = Array.from(document.querySelectorAll('table')).map(tb => ({
      headers: Array.from(tb.querySelectorAll('thead th')).map(t),
      rows: Array.from(tb.querySelectorAll('tbody tr')).slice(0, 6).map(r => Array.from(r.querySelectorAll('td')).map(c => t(c).slice(0, 40))),
    }));
    const cards = Array.from(document.querySelectorAll('.card')).map(t).filter(x => x.length < 200).slice(0, 15);
    const buttons = Array.from(document.querySelectorAll('button')).map(t).filter(Boolean).slice(0, 40);
    return { headings, fields, tables, cards, buttons };
  });
  const text = `===== ${id} ${label}\nurl: ${page.url()}\nheadings: ${JSON.stringify(data.headings)}\n` +
    `buttons: ${JSON.stringify(data.buttons)}\nfields:\n${data.fields.map((f: string) => '  ' + f).join('\n')}\n` +
    data.tables.map((tb: any, i: number) => `table ${i}: ${JSON.stringify(tb.headers)}\n` + tb.rows.map((r: string[]) => '   ' + JSON.stringify(r)).join('\n')).join('\n') +
    (data.cards.length ? `\ncards: ${JSON.stringify(data.cards)}` : '') + '\n';
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${id}.txt`), text);
  await page.screenshot({ path: path.join(OUT, `${id}.png`), fullPage: true }).catch(() => {});
  console.log(text.slice(0, 2500));
}

async function openAccount(page: any, customerManagementPage: any, accountId: string): Promise<void> {
  await page.navigateToHome();
  await customerManagementPage.navigateViaNav();
  await customerManagementPage.searchByAccountId(accountId);
  await customerManagementPage.clickFirstRowLink('ACCT No');
}

// Probes never move the tenant clock (the JASEC fixtures would otherwise rewind it to the baseline).
test.use({ ccpBaseline: null });

test.describe('UI candidate screens (read-only) @ui-candidates', () => {
  test.describe.configure({ mode: 'default' });
  test.setTimeout(240_000);

  test('V1 Subscription View + Services - subscription and service status', async ({ page, customerManagementPage, servicesPage }) => {
    await openAccount(page, customerManagementPage, A.suspended);
    await servicesPage.navigateSubscriptionView();
    await dump(page, 'V1a', `Subscription View ${A.suspended}`);
    await servicesPage.navigateViaSideMenu();
    await dump(page, 'V1b', `Services ${A.suspended}`);
  });

  test('V2 Balances - CRC balance and kWh accumulator', async ({ page, customerManagementPage, billsPage }) => {
    await openAccount(page, customerManagementPage, A.billed);
    await billsPage.navigateToBalance();
    await dump(page, 'V2', `Balances ${A.billed}`);
  });

  test('V3 Account Info + V4 Payment Profile', async ({ page, customerManagementPage, billsPage }) => {
    await openAccount(page, customerManagementPage, A.billed);
    await dump(page, 'V3', `Account Info ${A.billed}`);
    await (billsPage as any).sidebar.navigateTo('Account Data', 'Payment Profile');
    await dump(page, 'V4', `Payment Profile ${A.billed}`);
  });

  test('V5 Bills > Bill Pending dialog (look only)', async ({ page, customerManagementPage, billsPage }) => {
    await openAccount(page, customerManagementPage, A.billed);
    await billsPage.navigateToBills();
    await dump(page, 'V5a', `Bills ${A.billed}`);
    await page.getByRole('button', { name: 'Bill Pending charges' }).click({ timeout: 15_000 }).catch((e: any) => console.log('Bill Pending button:', String(e).slice(0, 120)));
    await dump(page, 'V5b', `Bill Pending dialog ${A.billed}`);
  });

  test('V6 Billing Hub > Usage - parked readings / batches', async ({ page, usagePage }) => {
    await page.navigateToHome();
    await usagePage.navigateViaNav();
    await dump(page, 'V6', 'Billing Hub Usage');
  });

  test('V7 Revenue Center > Revenues', async ({ page, revenuePage }) => {
    await page.navigateToHome();
    await revenuePage.navigateViaNav();
    await dump(page, 'V7', 'Revenues');
  });

  test('V8 + V14 Self Care - Make Payment grid and the balance header', async ({ page, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage }) => {
    await attachToAccountInSelfCare({ selfcareLoginPage, selfcareAccountSearchPage }, A.billed);
    await dump(page, 'V14', `Self Care landing ${A.billed}`);
    await selfcareActivityPage.navigateToMakePayment();
    await dump(page, 'V8', `Self Care Make Payment ${A.billed}`);
  });

  test('V9 AR Center > Accounts in Collection', async ({ page, collectionPage }) => {
    await page.navigateToHome();
    await collectionPage.navigateViaNav();
    await collectionPage.searchByAccountId(A.billed).catch((e: any) => console.log('search:', String(e).slice(0, 120)));
    await dump(page, 'V9', `Accounts in Collection ${A.billed}`);
  });

  test('V10 Daily Schedule screen (look only)', async ({ page, dailySchedulePage }) => {
    await page.navigateToHome();
    await (dailySchedulePage as any).navigateViaNav?.();
    await dump(page, 'V10', 'Daily Schedule');
  });

  test('V11 Order detail for the automatic SUSPEND and the failed RESUME', async ({ page }) => {
    const base = (process.env.EMBRIX_BASE_URL ?? '').replace(/\/$/, '');
    for (const [id, ord] of [['V11a', A.order], ['V11b', A.resumeOrder]]) {
      await page.goto(`${base}/orders/${ord}/detail`);
      await dump(page, id, `Order detail ${ord}`);
    }
  });

  test('V12 Customer Activity', async ({ page, customerManagementPage, accountInfoPage }) => {
    await openAccount(page, customerManagementPage, A.autoSusp);
    await accountInfoPage.navigateToCustomerActivity();
    await dump(page, 'V12', `Customer Activity ${A.autoSusp}`);
  });

  test('V13 Billing Hub invoice search grid', async ({ page, invoicePage }) => {
    await page.navigateToHome();
    await invoicePage.navigateViaNav();
    await dump(page, 'V13', 'Invoice search');
  });
});

test.describe('UI candidate screens - pass 2 @ui-candidates-2', () => {
  test.setTimeout(240_000);

  test('V4 Payment Profile', async ({ page, customerManagementPage, billsPage }) => {
    await openAccount(page, customerManagementPage, A.billed);
    await (billsPage as any).sidebar.navigateToSubScreen('Account Data', 'Payment Profile');
    await dump(page, 'V4', `Payment Profile ${A.billed}`);
  });

  test('V2b Balances on an account with usage', async ({ page, customerManagementPage, billsPage }) => {
    await openAccount(page, customerManagementPage, process.env.JASEC_UIC_USAGE ?? 'ACT-100003');
    await billsPage.navigateToBalance();
    await dump(page, 'V2b', 'Balances (account with usage)');
  });

  test('V5 Bill Pending dialog - open it', async ({ page, customerManagementPage, billsPage }) => {
    await openAccount(page, customerManagementPage, A.billed);
    await billsPage.navigateToBills();
    await page.waitForLoadState('networkidle');
    const btn = page.locator('button', { hasText: 'Bill Pending charges' }).first();
    console.log(`  Bill Pending button: count=${await btn.count()} visible=${await btn.isVisible().catch(() => false)} enabled=${await btn.isEnabled().catch(() => false)}`);
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 10_000 }).catch(async (e: any) => { console.log('  normal click failed:', String(e).slice(0, 100)); await btn.click({ force: true }).catch(() => {}); });
    await dump(page, 'V5c', `Bill Pending dialog ${A.billed}`);
  });

  test('V6 Suspended/Failed batches over a wide date range', async ({ page, usagePage }) => {
    await page.navigateToHome();
    await usagePage.navigateViaNav();
    const inputs = page.locator('input[name="startDate"], input[name="endDate"]');
    console.log(`  date inputs: ${await inputs.count()}`);
    if (await inputs.count() >= 2) { await inputs.nth(0).fill('2026-01-01'); await inputs.nth(1).fill('2028-12-31'); }
    await usagePage.clickSearchButton().catch((e: any) => console.log('  search:', String(e).slice(0, 100)));
    await dump(page, 'V6b', 'Suspended/Failed batches 2026-2028');
  });

  test('V14 Self Care after selecting the account - balance anywhere?', async ({ page, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage }) => {
    await attachToAccountInSelfCare({ selfcareLoginPage, selfcareAccountSearchPage }, A.billed);
    await page.waitForTimeout(3000);
    await dump(page, 'V14b', `Self Care home after selecting ${A.billed}`);
    await selfcareActivityPage.navigateToTopUp();
    await dump(page, 'V14c', `Self Care Top Up ${A.billed}`);
  });
});

test.describe('UI candidate screens - pass 3 (MUTATING: Bill Pending -> GENERATE_INVOICE) @ui-candidates-3', () => {
  test.setTimeout(300_000);
  test('V5 Bill Pending charges -> Process -> GENERATE_INVOICE', async ({ page, customerManagementPage, billsPage }) => {
    // It INVOICES an account mid-cycle (that is how A7 / invoice 000070 was made) - never as part of a plain
    // `--project=jasec-billing-explore` run.
    test.skip(String(process.env.JASEC_EXPLORE_BILL_RUN ?? '').trim().toLowerCase() !== 'true',
      'GATED: bills an account mid-cycle. Set JASEC_EXPLORE_BILL_RUN=true (and JASEC_UIC_PENDING=<own account>).');
    const acct = process.env.JASEC_UIC_PENDING ?? 'ACT-100128';
    await openAccount(page, customerManagementPage, acct);
    await billsPage.navigateToBills();
    await page.waitForLoadState('networkidle');
    const btn = page.locator('button', { hasText: 'Bill Pending charges' }).first();
    console.log(`  ${acct} Bill Pending button enabled=${await btn.isEnabled().catch(() => false)}`);
    await dump(page, 'V5d', `Bills before ${acct}`);
    await btn.click({ timeout: 15_000 });
    const popup = page.locator('[role="dialog"]').first();
    await popup.waitFor({ state: 'visible', timeout: 15_000 });
    await dump(page, 'V5e', `Bill Pending dialog ${acct}`);
    await popup.getByRole('button', { name: 'Process', exact: true }).click();
    await page.waitForTimeout(8000);
    await dump(page, 'V5f', `after Process ${acct}`);
    await billsPage.clickRadioButtonById();
    const actionGroup = page.locator('div.form-group.select-group', { hasText: 'Action' });
    await actionGroup.locator('.custom-react-select__control').click();
    const opts = await page.locator('.custom-react-select__option').allInnerTexts();
    console.log(`  Action options: ${JSON.stringify(opts)}`);
    await page.locator('.custom-react-select__option').filter({ hasText: 'GENERATE_INVOICE' }).first().click();
    await page.getByRole('button', { name: /SUBMIT/i }).first().click();
    await page.waitForTimeout(10_000);
    await dump(page, 'V5g', `after GENERATE_INVOICE ${acct}`);
  });
});

/**
 * CONTROL for TC-146's customer view: the same Self Care read (listInvoicesToPay) on an account that DOES
 * have open invoices must list them - otherwise "nothing to pay" on a settled prepaid account proves nothing.
 * Read-only. Default account: a postpaid dev account with ACTIVE invoices (JASEC_SC_CONTROL_ACCOUNT overrides).
 *
 *   npx playwright test --project=jasec-billing-explore --grep "@sc-control"
 */
test.describe('TC-146 control - Self Care lists open invoices @sc-control', () => {
  test('Self Care Make Payment lists the open invoices of an account that has them', async ({
    selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareMakePaymentPage,
  }) => {
    const acct = process.env.JASEC_SC_CONTROL_ACCOUNT ?? 'ACT-100572';
    const db = new DbHelper(new TestLogger('sc-control'));
    await db.connect();
    const open = await db.query<{ id: string }>(
      `SELECT id FROM core_engine.invoice_unit WHERE accountid = $1 AND status = 'ACTIVE' AND due > 0 ORDER BY id`, [acct])
      .finally(() => db.disconnect());
    console.log(`  ${acct}: open invoices in the database: ${open.map(o => o.id).join(', ') || 'none'}`);
    test.skip(open.length === 0, `BLOCKED: ${acct} has no open invoice - pick another with JASEC_SC_CONTROL_ACCOUNT`);
    await attachToAccountInSelfCare({ selfcareLoginPage, selfcareAccountSearchPage }, acct);
    await selfcareActivityPage.navigateToMakePayment();
    await selfcareMakePaymentPage.assertLoaded();
    const { asked, settled, listed } = await selfcareMakePaymentPage.listInvoicesToPay(selfcareActivityPage);
    console.log(`  Self Care: asked=${asked} settled=${settled} listed=${listed.map(l => `${l.invoiceId} due ${l.due}`).join(', ') || 'none'}`);
    expect(asked).toBe(true);
    expect(settled).toBe(true);
    expect(listed.length, 'the read found no invoice on an account that has open ones - the TC-146 check could never fail').toBeGreaterThan(0);
    expect.soft(open.map(o => o.id).filter(id => !listed.some(l => l.invoiceId === id)), 'open invoices missing from Self Care').toEqual([]);
  });
});

/**
 * CONTROL for helpers/agent-screens.helper.ts: on one of OUR accounts, the Services and Balances reads must
 * equal the database - in the test's own page AND in a second agent tab (the path Self Care specs use).
 * Read-only.   npx playwright test --project=jasec-billing-explore --grep "@agent-screens"
 */
test.describe('agent screens helper - control @agent-screens', () => {
  test('Services and Balances read what the database holds', async ({ page }) => {
    const acct = process.env.JASEC_AGENT_ACCOUNT;
    test.skip(!acct, 'BLOCKED: set JASEC_AGENT_ACCOUNT to one of our accounts');
    const db = new DbHelper(new TestLogger('agent-screens'));
    await db.connect();
    let truth: { sub: string; bal: number | null }[];
    try {
      const sub = await db.query<{ sub: string }>(
        `SELECT status AS sub FROM core_engine.subscription WHERE accountid = $1 ORDER BY id LIMIT 1`, [acct]);
      const raw = await db.getCrcBalanceAnyState(acct!);
      truth = [{ sub: sub[0]?.sub, bal: raw === null ? null : Math.round(Number(raw) * 100) / 100 }];
    } finally { await db.disconnect(); }
    console.log(`  DB ${acct}: subscription ${truth[0]?.sub}, CRC ${truth[0]?.bal}`);
    for (const [label, p] of [['own page', page], ['agent tab', await openAgentTab(page.context())]] as const) {
      const ui = new AgentScreens(p);
      const sv = await ui.services(acct!);
      const bal = await ui.crcBalance(acct!);
      console.log(`  ${label}: subscription ${sv.sub}, CRC ${bal}`);
      expect(sv.sub, `${label}: Services status`).toBe(truth[0].sub);
      expect(bal, `${label}: Balances CRC`).toBe(truth[0].bal);
    }
  });
});

/**
 * READ-ONLY probe of the accounting screens (Revenue + Revenue Configuration), for the business-facing
 * accounting walkthrough (2026-10-08). Opens each screen, dumps headings / buttons / filters / first rows.
 *   npx playwright test --project=jasec-billing-explore --grep "@acct-screens"
 */
test.describe('accounting screens - read-only probe @acct-screens', () => {
  test.setTimeout(300_000);
  const screens: Array<[string, string]> = [
    ['A1', '/revenue/journals'],
    ['A2', '/revenue/erp-extracts'],
    ['A3', '/revenue/accounting-log'],
    ['A4', '/revenue/revenue-accounting-reconciliation'],
    ['A5', '/revenue-configuration/erp-extract-batch'],
    ['A6', '/revenue-configuration/gl-accounts'],
    ['A7', '/revenue-configuration/chart-of-account'],
  ];
  for (const [id, route] of screens) {
    test(`${id} ${route}`, async ({ page }) => {
      const base = (process.env.EMBRIX_BASE_URL ?? '').replace(/\/$/, '');
      await page.goto(`${base}${route}`);
      await page.waitForLoadState('networkidle').catch(() => {});
      await dump(page, id, route);
    });
  }
});
