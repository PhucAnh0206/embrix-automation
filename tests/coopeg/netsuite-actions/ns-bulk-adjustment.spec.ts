/**
 * NetSuite — CRN-004: bulk credit through Core UI > AR Operations > Bulk Adjustments (coopegsbx2).
 *   1. Clock to NS_BULK_DATE (a credit window: on or after the account's latest credit note), always restored.
 *   2. Writes a new file (header + one credit line, ";"-separated, new name each run) and uploads it.
 *   3. Waits for processing (1 to 4 min): the file in File Upload Stats (search needs the exact full name),
 *      its line COMPLETED, the credit note on the invoice and its CREATE_CREDIT_NOTES answer from NetSuite.
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; $env:NS_BULK_INVOICE='<invoice of 208886>'; $env:NS_BULK_DATE='2027-11-03'
 *   npx playwright test tests/coopeg/netsuite-actions/ns-bulk-adjustment.spec.ts --project=dev --reporter=line
 * Optional: NS_BULK_ACCOUNT (208886), NS_BULK_AMOUNT (100), NS_BULK_REASON ("Corrección" not stamped;
 * "NC - Error en facturación" stamped). Writes test-results/ns-bulk-adjustment.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../fixtures/page-factory';

const GQL = 'https://service-transactional.coopegsbx2.embrix.org/graphql';
const ACC = process.env.NS_BULK_ACCOUNT ?? '208886';
const INV = process.env.NS_BULK_INVOICE ?? '';
const DATE = process.env.NS_BULK_DATE ?? '';
const AMOUNT = process.env.NS_BULK_AMOUNT ?? '100';
const REASON = process.env.NS_BULK_REASON ?? 'Corrección';

const gql = async (query: string) => (await (await fetch(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })).json()) as any;
const clock = async (): Promise<string> => (await gql('{ getCcpDateTime(dummy:"x") { ccpTime } }')).data.getCcpDateTime.ccpTime;
const setClock = async (d: string) => { await gql(`mutation { setCcpTime(input:{ccpTime:"${d}"}) { ccpTime } }`); return clock(); };
const notes = async () => (await gql(`{ searchNotesUnits(page:1,size:200,filter:{accountId:"${ACC}",startDate:"2000-01-01",endDate:"2099-12-31"}) { id invoiceId total reasonDescription folioStatus financeSyncStatus financeErrorMessage } }`)).data?.searchNotesUnits ?? [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('CRN-004: bulk credit upload reaches NetSuite', async ({ page, baseURL, testLogger }) => {
  test.setTimeout(20 * 60_000);
  expect(process.env.TEST_ENV, 'coopegsbx2 only').toBe('coopegsbx2');
  expect(INV, 'NS_BULK_INVOICE').toMatch(/^\d+$/);
  expect(DATE, 'NS_BULK_DATE (credit window)').toMatch(/^\d{4}-\d{2}-\d{2}$/);

  const name = `qa_ns_crn004_${new Date().toISOString().replace(/\D/g, '').slice(4, 12)}.csv`;
  const file = path.join('test-results', name);
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync(file, 'adjustmenttype;source;userId;artype;reason;customreason;taxrule;accountid;invoiceid;amount;percent;startdate;ticketnumber;notes\n'
    + `BILL_ADJUSTMENT;AGENT_CARE;congeroadmin;CREDIT;;${REASON};WITH_TAX;${ACC};${INV};${AMOUNT};;;;QA-NS-CRN-004\n`);
  const out: any = { file: name, account: ACC, invoice: INV, amount: AMOUNT, reason: REASON };
  const before = new Set((await notes()).map((n: any) => n.id));
  const base = await clock();
  try {
    testLogger.log(`clock ${base} -> ${await setClock(DATE)}`);
    await page.goto(`${baseURL!.replace(/\/+$/, '')}/ar-operations/bulk-adjustments`, { waitUntil: 'domcontentloaded' });
    await page.getByText('File Upload Stats').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: /^upload$/i }).first().click();
    const dialog = page.locator('.modal, [role=dialog]').filter({ hasText: 'Upload Bulk Adjustment File' });
    await dialog.waitFor({ timeout: 30_000 });
    await page.locator('input[type=file]').setInputFiles(file);
    await page.waitForTimeout(2000);
    out.uploadedAt = new Date().toISOString();
    await dialog.getByRole('button', { name: /^upload$/i }).click();
    await expect(page.getByText(/Create File successfully/i)).toBeVisible({ timeout: 30_000 });
    testLogger.log(`${name} uploaded at ${out.uploadedAt}`);

    // The file is processed 1 to 4 minutes after the upload; the credit note appears when its line is done.
    for (let i = 0; i < 20 && !out.note; i++) {
      await sleep(30_000);
      out.note = (await notes()).find((n: any) => !before.has(n.id) && n.invoiceId === INV);
    }
    // File Upload Stats: the search finds only the exact full file name.
    await page.locator('input[name=fileName]').fill(name);
    await page.getByRole('button', { name: /^search$/i }).click();
    await page.waitForTimeout(5000);
    out.stats = (await page.locator('tbody').innerText()).trim();
    await page.locator('tbody').getByText('View').first().click();
    await page.waitForTimeout(5000);
    out.lines = (await page.locator('body').innerText()).match(/Created Date[\s\S]*?(?=\n\d+\nPage size|$)/)?.[0];
    await page.screenshot({ path: `test-results/ns-bulk-${name}.png`, fullPage: true }).catch(() => {});
  } finally {
    testLogger.log(`clock restored ${await setClock(base)}`);
  }
  if (out.note) {
    await sleep(20_000);
    out.note = (await notes()).find((n: any) => n.id === out.note.id);
    const acts = (await gql(`{ searchActivities(page:1,size:100,filter:{accountId:"${ACC}"}) { id apiName entityId request response } }`)).data?.searchActivities ?? [];
    const a = acts.find((x: any) => x.entityId === out.note.id && x.apiName === 'CREATE_CREDIT_NOTES');
    out.netsuite = { activity: a?.id, request: a?.request && JSON.parse(a.request)?.creditMemo, response: a?.response && JSON.parse(a.response) };
  }
  fs.writeFileSync('test-results/ns-bulk-adjustment.json', JSON.stringify(out, null, 1));
  testLogger.log(`stats: ${out.stats}`);
  testLogger.log(`lines: ${String(out.lines).replace(/\s+/g, ' ')}`);
  testLogger.log(`credit note: ${JSON.stringify(out.note)}; NetSuite ${JSON.stringify(out.netsuite?.response)}`);
  expect.soft(out.stats, 'file listed: success 1, failure 0, pending 0, total 1').toMatch(new RegExp(`${name.replace('.', '\\.')}\\s+\\S+\\s+1\\s+0\\s+0\\s+1`));
  expect.soft(out.lines ?? '', 'line COMPLETED').toMatch(/PROCESS_ADJUSTMENT\s+COMPLETED/);
  expect(out.note, 'credit note created on the invoice').toBeTruthy();
  expect(out.note.financeSyncStatus).toBe('SUCCESS');
  expect(out.netsuite?.response?.error, 'accepted by NetSuite').toBe(false);
});
