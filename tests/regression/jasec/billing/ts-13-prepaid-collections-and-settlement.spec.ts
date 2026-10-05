/**
 * TC-142 - A prepaid invoice is settled from the balance and never goes to collections.
 *
 * READ-ONLY. Safe on any environment, including the final customer build.
 *
 * The rule (Luis, 2026-10-05, answering tracker item 9b): "Invoices should not remain as open, no collections
 * actions need to be taken." Billing takes a prepaid charge from the balance, so the invoice it produces is
 * already paid: nothing due, not open, and never chased.
 *
 * Why it fails today (Adrian's preprod report 2026-10-03; dev + preprod 2026-10-05): the charge is taken from
 * the balance but the invoice stays ACTIVE with the full amount due and no payment record. The JASEC DAILY
 * schedule contains COLLECTION_CREATE, which selects CHECK invoices with due > 0 past their due date - so
 * prepaid customers whose money was already taken are put into collections. dev 2026-10-05: 1,460 prepaid
 * invoices in COLLECTION, 1,191 ACTIVE with the full amount due, 7 CLOSED; open collection units on 257 accounts.
 *
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
 *
 * Old data: invoices and collection units created before a fix stay in the data until the team cleans them
 * up. Scope tests 1 and 2 with JASEC_SETTLEMENT_SINCE=YYYY-MM-DD (tenant invoice date / unit creation date
 * on or after it). Test 3 needs no scope.
 *
 *   npx playwright test --project=jasec-billing-settlement
 */
import { test, expect } from '@playwright/test';
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

  test('the invoices from the latest billing run are settled @tc-142', async () => {
    if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
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
    for (const r of rows) console.log(`    ${r.id}  ${r.accountid}  ${r.status}  total ${r.total} due ${r.due}`);
    expect(rows.length, `recorded invoice(s) missing from invoice_unit: ${run!.invoices.map(i => i.invoiceId).join(', ')}`)
      .toBe(run!.invoices.length);
    const open = rows.filter(r => r.total > 0 && (r.due !== 0 || r.status === 'ACTIVE' || r.status === 'COLLECTION'));
    expect(open.map(r => `${r.id} ${r.accountid} ${r.status} due ${r.due} of ${r.total}`),
      `invoice(s) from the ${run!.date} run still open although billing took the charge from the balance`).toEqual([]);
  });
});
