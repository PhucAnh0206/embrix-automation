/**
 * TC-142 - A prepaid invoice is settled from the balance and never goes to collections.
 *
 * READ-ONLY. Safe on any environment, including the final customer build.
 *
 * The rule (Luis, 2026-10-05, answering tracker item 9b): "Invoices should not remain as open, no collections
 * actions need to be taken." Billing takes a prepaid charge from the balance, so the invoice it produces is
 * already paid: nothing due, not open, and never chased.
 *
 * History: until the team's 2026-10-05 release the charge was taken from the balance but the invoice stayed ACTIVE with the
 * full amount due, and the DAILY COLLECTION_CREATE moved it into collections (dev: 1,460 invoices, 257 accounts).
 * Since the release (verified dev + preprod 2026-10-05) a new prepaid invoice is created CLOSED / due 0 with a
 * SETTLEMENT line on the account statement, and the old ones were cleaned.

 * Asserts the OUTCOME only - nothing due, status neither ACTIVE nor COLLECTION, no open collection unit -
 * not HOW it is achieved (a payment record, a CLOSED status, COLLECTION_CREATE dropped for prepaid).
 * Invoice statuses on JASEC: ACTIVE, COLLECTION, CLOSED.
 *
 * Three tests:
 *   1. every prepaid invoice with a charge is settled                       (whole tenant)
 *   2. no prepaid account holds an open collection unit                      (whole tenant)
 *   3. the invoices the LATEST billing run produced are settled              (prospective - the fresh evidence)
 *      Reads artifacts/billing-run-invoices.json, written by ts-06 (TC-139). BLOCKED if there is none for
 *      this tenant. In run-suite this runs AFTER the billing runs, so it judges that run's invoices.
 *      Checked on the CORE UI first, as an agent sees it, then in the DATABASE (the record behind the screen):
 *        - Bills > Open/Closed Bills: Invoice Status CLOSED, Due 0
 *        - Account Statement: a SETTLEMENT row for the invoice, Total = -invoice total, Closing Balance 0
 *      and from the CUSTOMER's side (Self Care > Make Payment: nothing to pay), and AR Center > Accounts in
 *      Collection: the account is not listed. Both fail closed (the grid fetch and the search filter are proven).
 *
 * Old data: invoices and collection units created before a fix stay in the data until the team cleans them
 * up. Scope tests 1 and 2 with JASEC_SETTLEMENT_SINCE=YYYY-MM-DD (tenant invoice date / unit creation date
 * on or after it). Test 3 needs no scope.
 *
 *   npx playwright test --project=jasec-billing-settlement
 */
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { attachToAccountInSelfCare } from '../../../../fixtures/create-prepaid-account.helper';
import { uiNum } from '../../../../pages/billing-hub/invoice-detail.page';
import * as fs from 'fs';
import * as path from 'path';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const SINCE = (process.env.JASEC_SETTLEMENT_SINCE ?? '').trim();
const BAD_SINCE = !!SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE);
const BILLING_RUN_FILE = path.resolve(__dirname, '../../../../artifacts/billing-run-invoices.json');
/** An invoice is OPEN (unsettled) when anything is due or its status is ACTIVE / COLLECTION. */
const OPEN = `(iu.due <> 0 OR iu.status IN ('ACTIVE', 'COLLECTION'))`;

test.describe('TC-142 prepaid invoice settled, never in collections @tc-142 @prepaid-collections', () => {
  // Read-only: never move the clock (the JASEC fixtures would otherwise rewind it to the baseline).
  test.use({ ccpBaseline: null });
  let db: DbHelper;
  test.beforeAll(async () => {
    if (!hasDbConfig()) return;
    db = new DbHelper();
    await db.connect();
  });
  test.afterAll(async () => { if (db) await db.disconnect(); });

  test('every prepaid invoice charged from the balance is settled - nothing due, not open @tc-142', async () => {
    if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
    if (blockedIf(BAD_SINCE, `JASEC_SETTLEMENT_SINCE='${SINCE}' is not YYYY-MM-DD`)) return;

    const scope = `a.accountcategory = 'PREPAID' AND iu.total > 0${SINCE ? ` AND iu.invoicedate::date >= $1::date` : ''}`;
    const params = SINCE ? [SINCE] : [];
    const split = await db.query<{ status: string; due: string; n: number }>(
      `SELECT iu.status, CASE WHEN iu.due = 0 THEN 'nothing due' WHEN iu.due = iu.total THEN 'full amount due' ELSE 'part due' END AS due,
              count(*)::int n
         FROM core_engine.invoice_unit iu JOIN core_engine.account a ON a.id = iu.accountid
        WHERE ${scope} GROUP BY 1, 2 ORDER BY n DESC`, params);
    const open = await db.query<{ id: string; accountid: string; status: string; total: number; due: number; invoicedate: string }>(
      `SELECT iu.id, iu.accountid, iu.status, iu.total::float8 total, iu.due::float8 due, iu.invoicedate::date::text invoicedate
         FROM core_engine.invoice_unit iu JOIN core_engine.account a ON a.id = iu.accountid
        WHERE ${scope} AND ${OPEN} ORDER BY iu.invoicedate DESC, iu.id DESC LIMIT 5`, params);
    const openCount = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM core_engine.invoice_unit iu JOIN core_engine.account a ON a.id = iu.accountid
        WHERE ${scope} AND ${OPEN}`, params);
    const n = openCount[0]?.n ?? 0;
    const total = split.reduce((s, r) => s + r.n, 0);
    console.log(`  prepaid invoices with a charge${SINCE ? ` (since ${SINCE})` : ''}: ${total} - ` +
      (split.map(r => `${r.status} / ${r.due}: ${r.n}`).join('; ') || 'none'));
    for (const o of open) console.log(`    OPEN ${o.id}  ${o.accountid}  ${o.status}  total ${o.total} due ${o.due}  ${o.invoicedate}`);

    if (blockedIf(total === 0, `no prepaid invoice with a charge${SINCE ? ` since ${SINCE}` : ''} on this tenant - nothing to judge`)) return;
    expect(n, `${n} of ${total} prepaid invoice(s) are still open after billing took the charge from the balance - ` +
      `the invoice must be settled (nothing due, not ACTIVE / COLLECTION). Latest: ` +
      open.map(o => `${o.id} ${o.accountid} ${o.status} due ${o.due}`).join('; ')).toBe(0);
  });

  test('no prepaid account is put into collections @tc-142', async () => {
    if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
    if (blockedIf(BAD_SINCE, `JASEC_SETTLEMENT_SINCE='${SINCE}' is not YYYY-MM-DD`)) return;

    const where = `a.accountcategory = 'PREPAID' AND cu.status <> 'CLOSED'${SINCE ? ` AND cu.createddate::date >= $1::date` : ''}`;
    const params = SINCE ? [SINCE] : [];
    const total = await db.query<{ accts: number; units: number }>(
      `SELECT count(DISTINCT cu.accountid)::int accts, count(*)::int units
         FROM core_engine.collection_units cu JOIN core_engine.account a ON a.id = cu.accountid
        WHERE ${where}`, params);
    const sample = await db.query<{ accountid: string; invoiceid: string; status: string; created: string }>(
      `SELECT cu.accountid, cu.invoiceid, cu.status, cu.createddate::date::text created
         FROM core_engine.collection_units cu JOIN core_engine.account a ON a.id = cu.accountid
        WHERE ${where} ORDER BY cu.createddate DESC LIMIT 5`, params);
    const { accts, units } = total[0] ?? { accts: 0, units: 0 };
    console.log(`  prepaid accounts with open collection units${SINCE ? ` (since ${SINCE})` : ''}: ${accts} (${units} units)`);
    for (const s of sample) console.log(`    ${s.accountid}  invoice ${s.invoiceid}  ${s.status}  created ${s.created}`);

    expect(accts, `${accts} prepaid account(s) hold ${units} open collection unit(s) - no collection action may be ` +
      `taken on prepaid. Latest: ${sample.map(s => `${s.accountid}/${s.invoiceid}`).join(', ')}`).toBe(0);
  });

  test('the invoices from the latest billing run are settled - database and Core UI @tc-142', async ({
    page, customerManagementPage, billsPage, collectionPage,
    selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareMakePaymentPage,
  }) => {
    if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
    test.setTimeout(300_000);
    let run: { tenant: string; date: string; invoices: { accountId: string; invoiceId: string }[] } | null = null;
    try { run = JSON.parse(fs.readFileSync(BILLING_RUN_FILE, 'utf8')); } catch { run = null; }
    if (blockedIf(!run, `no ${path.basename(BILLING_RUN_FILE)} - run TC-139 (billing/ts-06) first; it records the invoices it produced`)) return;
    if (blockedIf(run!.tenant !== process.env.TEST_ENV,
      `the recorded billing run is from ${run!.tenant}, not ${process.env.TEST_ENV} - run TC-139 on this tenant first`)) return;
    if (blockedIf(run!.invoices.length === 0, `the billing run of ${run!.date} produced no invoice - nothing to judge`)) return;

    const rows = await db.query<{ id: string; accountid: string; status: string; total: number; due: number }>(
      `SELECT iu.id, iu.accountid, iu.status, iu.total::float8 total, iu.due::float8 due
         FROM core_engine.invoice_unit iu WHERE iu.id = ANY($1::text[])`, [run!.invoices.map(i => i.invoiceId)]);
    console.log(`  billing run ${run!.date} on ${run!.tenant}: ${run!.invoices.length} invoice(s)`);
    expect(rows.length, `recorded invoice(s) missing from invoice_unit: ${run!.invoices.map(i => i.invoiceId).join(', ')}`)
      .toBe(run!.invoices.length);

    for (const inv of rows.filter(r => r.total > 0)) {
      await test.step(`Core UI: ${inv.accountid} Bills and Account Statement show ${inv.id} settled`, async () => {
        await page.navigateToHome();
        await customerManagementPage.navigateViaNav();
        await customerManagementPage.searchByAccountId(inv.accountid);
        await customerManagementPage.clickFirstRowLink('ACCT No');

        await billsPage.navigateToBills();
        const bill = (await billsPage.openClosedBillRows()).find(r => r['Invoice Id'] === inv.id);
        console.log(`    UI  Bills: ${bill ? `${inv.id} status "${bill['Invoice Status']}", due "${bill['Due']}"` : `${inv.id} NOT LISTED`}`);
        expect.soft(bill, `Core UI Bills: invoice ${inv.id} is listed under Open/Closed Bills`).toBeTruthy();
        if (bill) {
          expect.soft(bill['Invoice Status'], `Core UI Bills: ${inv.id} Invoice Status`).toBe('CLOSED');
          expect.soft(uiNum(bill['Due']), `Core UI Bills: ${inv.id} Due`).toBe(0);
        }

        await billsPage.navigateToAccountStatement();
        const lines = await billsPage.accountStatementRows();
        const s1 = lines.find(r => r['Document Type'] === 'SETTLEMENT' && r['Invoice Id'] === inv.id);
        console.log(`    UI  Account Statement: ${s1 ? `SETTLEMENT ${inv.id} total "${s1['Total']}", closing "${s1['Closing Balance']}"` : `no SETTLEMENT row for ${inv.id}`}`);
        expect.soft(s1, `Core UI Account Statement: a SETTLEMENT row for ${inv.id}`).toBeTruthy();
        if (s1) {
          expect.soft(uiNum(s1['Total']), `Core UI Account Statement: SETTLEMENT total for ${inv.id}`).toBeCloseTo(-inv.total, 2);
          expect.soft(uiNum(s1['Closing Balance']), `Core UI Account Statement: closing balance after ${inv.id}`).toBeCloseTo(0, 2);
        }
      });

      await test.step(`Self Care: the customer of ${inv.accountid} has nothing to pay`, async () => {
        await attachToAccountInSelfCare({ selfcareLoginPage, selfcareAccountSearchPage }, inv.accountid);
        await selfcareActivityPage.navigateToMakePayment();
        await selfcareMakePaymentPage.assertLoaded();
        // The grid fetches only after a reload (known Self Care defect, see reloadToPopulateGrid). Wait for the
        // fetch itself: an empty grid must mean "no invoice to pay", never "the list was not asked for".
        const fetched = page.waitForResponse(r => /searchInvoiceUnits/.test(r.request().postData() ?? ''), { timeout: 30_000 })
          .then(() => true, () => false);
        await selfcareMakePaymentPage.reloadToPopulateGrid(selfcareActivityPage);
        const asked = await fetched;
        const listed = asked ? await selfcareMakePaymentPage.getListedInvoices() : [];
        console.log(`    SC  Make Payment: ${asked ? (listed.map(l => `${l.invoiceId} due ${l.due}`).join(', ') || 'nothing to pay') : 'invoice list NOT fetched'}`);
        expect(asked, 'Self Care Make Payment never fetched the invoice list - an empty grid would prove nothing').toBe(true);
        expect.soft(listed.map(l => l.invoiceId),
          `Self Care offers ${inv.accountid} invoice(s) to pay although billing took the money from the balance`).toEqual([]);
      });

      await test.step(`Core UI AR: ${inv.accountid} is not in collections`, async () => {
        await page.navigateToHome();
        await collectionPage.navigateViaNav();
        await collectionPage.searchByAccountId(inv.accountid);
        // Prove the filter applied before trusting an empty result.
        const filter = await page.locator("//input[@name='accountId']").first().inputValue().catch(() => '');
        const rows = await page.locator('table').first().locator('tbody tr').allInnerTexts();
        const hits = rows.filter(r => r.includes(inv.accountid));
        console.log(`    AR  Accounts in Collection (filter "${filter}"): ${hits.length ? hits.join(' | ').slice(0, 160) : 'no record'}`);
        expect(filter, 'the Accounts in Collection search did not apply the account filter').toBe(inv.accountid);
        expect.soft(hits.length, `${inv.accountid} is listed in Accounts in Collection`).toBe(0);
      });

      await test.step(`database: ${inv.id} (${inv.accountid}) is settled and its statement closes at 0`, async () => {
        const settle = await db.query<{ amount: number; closing: number }>(
          `SELECT amount::float8 amount, closingbalance::float8 closing FROM core_engine.account_statement
            WHERE accountid = $1 AND invoiceid = $2 AND linetype = 'SETTLEMENT'`, [inv.accountid, inv.id]);
        console.log(`    DB  ${inv.id}  ${inv.status}  total ${inv.total} due ${inv.due} | SETTLEMENT ` +
          (settle.map(x => `${x.amount} -> closing ${x.closing}`).join(', ') || 'NONE'));
        expect.soft(inv.status, `${inv.id}: invoice status`).not.toMatch(/^(ACTIVE|COLLECTION)$/);
        expect.soft(inv.due, `${inv.id}: amount due`).toBe(0);
        expect.soft(settle.length, `${inv.id}: exactly one SETTLEMENT line on the account statement`).toBe(1);
        if (settle.length) {
          expect.soft(settle[0].amount, `${inv.id}: SETTLEMENT amount = minus the invoice total`).toBeCloseTo(-inv.total, 2);
          expect.soft(settle[0].closing, `${inv.id}: statement closing balance after the settlement`).toBeCloseTo(0, 2);
        }
      });
    }
  });
});
