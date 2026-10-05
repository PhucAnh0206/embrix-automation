/**
 * EXPLORATORY probe (read-only) - what the Core UI shows for a settled prepaid invoice.
 * Dumps the table headers + rows of: account Bills, account Account Statement, AR Accounts in Collection.
 * Used once to learn the screens before wiring UI steps into TC-142 / TC-141. Not a case.
 *   $env:JASEC_PROBE_ACCOUNT='ACT-101205'; npx playwright test --project=jasec-billing-explore --grep "@settlement-screens"
 */
import { test } from '../../../../fixtures/page-factory';
import * as fs from 'fs';
import * as path from 'path';

const ACCOUNT = (process.env.JASEC_PROBE_ACCOUNT ?? '').trim();

async function dumpTables(page: any, label: string): Promise<string> {
  await page.waitForTimeout(3000);
  const tables = await page.locator('table').evaluateAll((ts: HTMLTableElement[]) => ts.map(t => ({
    headers: Array.from(t.querySelectorAll('thead th')).map(h => (h.textContent ?? '').trim()),
    rows: Array.from(t.querySelectorAll('tbody tr')).slice(0, 8).map(r =>
      Array.from(r.querySelectorAll('td')).map(c => (c.textContent ?? '').trim().slice(0, 40))),
  })));
  const h5 = await page.locator('h5, h4, h3').allInnerTexts().catch(() => []);
  return `\n===== ${label} (${page.url()})\nheadings: ${JSON.stringify(h5)}\n` +
    tables.map((t: any, i: number) => `table ${i}: ${JSON.stringify(t.headers)}\n` + t.rows.map((r: string[]) => `   ${JSON.stringify(r)}`).join('\n')).join('\n');
}

test('settlement as the Core UI shows it @settlement-screens', async ({ page, customerManagementPage, billsPage }) => {
  test.skip(!ACCOUNT, 'set JASEC_PROBE_ACCOUNT');
  test.setTimeout(240_000);
  let out = '';
  await page.navigateToHome();
  await customerManagementPage.navigateViaNav();
  await customerManagementPage.searchByAccountId(ACCOUNT);
  await customerManagementPage.clickFirstRowLink('ACCT No');

  await billsPage.navigateToBills();
  out += await dumpTables(page, 'Bills');
  await page.screenshot({ path: `artifacts/ui-surface/settlement-bills-${ACCOUNT}.png`, fullPage: true });

  await billsPage.navigateToAccountStatement();
  out += await dumpTables(page, 'Account Statement');
  await page.screenshot({ path: `artifacts/ui-surface/settlement-statement-${ACCOUNT}.png`, fullPage: true });

  fs.mkdirSync('artifacts/ui-surface', { recursive: true });
  fs.writeFileSync(path.join('artifacts/ui-surface', `settlement-screens-${ACCOUNT}.txt`), out);
  console.log(out);
});
