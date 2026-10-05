/**
 * Prepaid accounts never go into collections; how prepaid invoices are settled is recorded.
 *
 * READ-ONLY. Safe on any environment, including the final customer build.
 *
 * Why: Adrian's preprod report, 2026-10-03 (open-questions tracker item 9). After billing, the charge is taken
 * from the prepaid balance but the invoice stays ACTIVE with the full amount due and no payment record. The
 * JASEC DAILY schedule contains COLLECTION_CREATE, which selects CHECK invoices with due > 0 past their due
 * date - so prepaid customers whose money was already taken are put into collections.
 * dev 2026-10-05: 1,460 prepaid invoices in COLLECTION, OPEN collection units on 257 prepaid accounts.
 *
 * TEST 1 - a real check. JASEC prepaid has no collections flow: suspension is balance-driven, not driven by
 * overdue invoices (docs/2026 JASEC/JASEC-knowledge.md). So no prepaid account may hold an open collection
 * unit. This does not depend on the open question below.
 *   Historical units from before a fix stay in the data; once the team has fixed and cleaned up, scope the
 *   check with JASEC_COLLECTIONS_SINCE=YYYY-MM-DD (units created on/after that tenant date).
 *
 * TEST 2 - RECORDS, does not judge. Whether a prepaid invoice should be settled (due 0 / CLOSED) when the
 * balance is debited is an OPEN team decision (tracker item 9). It reports the split; once the team answers,
 * assert that answer here.
 *
 *   npx playwright test --project=jasec-billing-read --grep "@prepaid-collections"
 */
import { test, expect } from '@playwright/test';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const SINCE = (process.env.JASEC_COLLECTIONS_SINCE ?? '').trim();

test.describe('Prepaid collections and invoice settlement @prepaid-collections', () => {
  let db: DbHelper;
  test.beforeAll(async () => {
    if (!hasDbConfig()) return;
    db = new DbHelper();
    await db.connect();
  });
  test.afterAll(async () => { if (db) await db.disconnect(); });

  test('no prepaid account is put into collections @prepaid-collections', async () => {
    if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
    if (blockedIf(!!SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE), `JASEC_COLLECTIONS_SINCE='${SINCE}' is not YYYY-MM-DD`)) return;

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

    expect(accts, `${accts} prepaid account(s) hold ${units} open collection unit(s) - JASEC prepaid has no ` +
      `collections flow, so a customer whose charge was taken from the balance is being chased for it. ` +
      `Tracker item 9 (Adrian, 2026-10-03). Latest: ${sample.map(s => `${s.accountid}/${s.invoiceid}`).join(', ')}`)
      .toBe(0);
  });

  test('prepaid invoice settlement after billing - recorded, decision pending @prepaid-collections', async () => {
    if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
    const r = await db.query<{ status: string; due: string; n: number }>(
      `SELECT iu.status,
              CASE WHEN iu.due = 0 THEN 'nothing due' WHEN iu.due = iu.total THEN 'full amount due' ELSE 'part due' END AS due,
              count(*)::int n
         FROM core_engine.invoice_unit iu JOIN core_engine.account a ON a.id = iu.accountid
        WHERE a.accountcategory = 'PREPAID' AND iu.total > 0
        GROUP BY 1, 2 ORDER BY n DESC`);
    const line = r.map(x => `${x.status} / ${x.due}: ${x.n}`).join('; ') || 'no prepaid invoices';
    test.info().annotations.push({
      type: 'decision-pending',
      description: `Prepaid invoices: ${line}. Should a prepaid invoice be settled when the balance is debited? ` +
        `Open - tracker item 9. Not a verdict.`,
    });
    console.log(`  RECORDED, decision pending - prepaid invoices: ${line}`);
  });
});
