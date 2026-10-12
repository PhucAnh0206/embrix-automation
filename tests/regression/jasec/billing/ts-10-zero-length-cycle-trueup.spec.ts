/**
 * The 0-30 kWh true-up and the cycle length it depends on — point 9 of the
 * 2026-09-15 E2E guide.
 *
 * A cycle that consumed less than 30 kWh must be trued up to the monthly fixed
 * charge: four VOLUME_DISCOUNT lines totalling 1,943.40. Verified shape, taken
 * from the guide's reference bill unit 4951 on jasec-dev:
 *
 *     VOLUME_DISCOUNT  I-100003  ENERGIA                   1880.70
 *     VOLUME_DISCOUNT  I-100004  CVG ENERGIA                -17.40
 *     VOLUME_DISCOUNT  I-100005  ALUMBRADO PUBLICO           80.10
 *     VOLUME_DISCOUNT  I-100006  CVG ALUMBRADO PUBLICO        0.00
 *                                                        = 1943.40
 *
 * THE CASE THIS ADDS. Huy found the true-up did NOT fire for ACT-100876, and the
 * cause was the CYCLE, not the tariff: the account was created on the simulated
 * clock date and `runPendingBill` then closed the cycle on that same date, so the
 * period was ZERO DAYS long and no true-up line was produced at all. A back-dated
 * order is refused (BACKDATED_EFFECTIVE_DATE), so the only way to get a real
 * cycle is to create the account, move the clock FORWARD, and then bill.
 *
 * Two tests:
 *   A  (TC-58) a real cycle -> the true-up fires, and the bill carrying the
 *      -17.40 CVG credit must also invoice
 *   B  (TC-59) a zero-length cycle cannot occur in production. Huy's question
 *      ("should a same-day cycle still bill the fixed charge?") was ANSWERED on
 *      JEPYP-319 Q2, 2026-10-08 (Luis): an account created ON its billing day gets
 *      a full month (preprod ACT-100294: 12-01 -> 01-01). Test B asserts that rule.
 *      ACT-100876's zero-day cycle came from the old runPendingBill API closing the
 *      cycle on the creation date - not something production does.
 *
 * ── MUTATING, AND IT MOVES A SHARED CLOCK ──────────────────────────────────
 * Seeds accounts, MOVES THE TENANT-GLOBAL CCP CLOCK, and bills irreversibly.
 * Billed THROUGH THE CORE UI since 2026-10-06 (was the runPendingBill / invoiceAccount API):
 *   A  on a free billing day, the cycle is closed and invoiced by the operator's daily run - Operations Hub >
 *      Daily Schedule > Create > Process - exactly as production does it. ("Bill Pending charges" on the
 *      Bills screen is DISABLED for a 0-kWh cycle, so a manual bill is not how this cycle gets billed.)
 *   B  seeds an account whose billing day is TODAY's day and reads its first cycle - no billing, no clock move.
 * Only ever on accounts this spec created. The clock is restored afterwards. Gated behind JASEC_TRUEUP_RUN=true.
 *
 *     $env:JASEC_TRUEUP_RUN='true'
 *     npx playwright test --project=jasec-billing-trueup
 *
 * Coordinate before running: another session's date-sensitive spec will see the
 * clock move.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '../../../../fixtures/page-factory';
import { AgentScreens, uiAmount } from '../../../../helpers/agent-screens.helper';
import { DbHelper } from '../../../../helpers/db.helper';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { OrderOutcomeHelper } from '../../../../helpers/order-outcome.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN_ENABLED = String(process.env.JASEC_TRUEUP_RUN ?? '').trim().toLowerCase() === 'true';

/** The monthly fixed charge a sub-30 kWh cycle must be trued up to. */
const FIXED_CHARGE = 1943.40;

/** The four true-up lines, by item, exactly as bill unit 4951 carries them. */
const EXPECTED_TRUEUP = [
  { itemId: 'I-100003', description: 'ENERGIA', amount: 1880.70 },
  { itemId: 'I-100004', description: 'CVG ENERGIA', amount: -17.40 },
  { itemId: 'I-100005', description: 'ALUMBRADO PUBLICO', amount: 80.10 },
  { itemId: 'I-100006', description: 'CVG ALUMBRADO PUBLICO', amount: 0.00 },
];

const money = (n: number) => Math.round(n * 100) / 100;

/** The account's open (PENDING) bill unit - the cycle the screen's Bill Pending will close. */
async function pendingBillUnit(db: DbHelper, accountId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `SELECT bu.id FROM core_engine.billing_profile bp
       JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
      WHERE bp.accountid = $1`, [accountId]);
  return r[0]?.id ?? '';
}

/** Core UI > the account > Billing Data > Bills. */
async function openBills(page: any, customerManagementPage: any, billsPage: any, accountId: string) {
  await new AgentScreens(page).openAccount(accountId);
  await billsPage.navigateToBills();
}

async function trueUpLines(db: DbHelper, billUnitId: string) {
  return db.query<any>(
    `SELECT itemid, description, netamount::float8 AS netamount
       FROM core_engine.transaction_unit
      WHERE billunitid = $1 AND type = 'VOLUME_DISCOUNT'
      ORDER BY itemid`,
    [billUnitId],
  );
}

test.describe('JASEC billing — 0-30 kWh true-up and cycle length (MUTATING)', {
  tag: ['@jasec', '@billing', '@trueup'],
}, () => {
  test.setTimeout(15 * 60 * 1000);

  test('A — a real cycle under 30 kWh is trued up to the fixed charge, and invoices', { tag: '@tc-58' }, async ({ page, customerManagementPage, billsPage, dailySchedulePage }) => {
    blockedIf(
      !RUN_ENABLED,
      'JASEC_TRUEUP_RUN is not "true". This spec moves the TENANT-GLOBAL CCP clock ' +
      'and bills accounts irreversibly, so it never runs by accident.',
    );

    const logger = new TestLogger('ts-10-trueup-real-cycle');
    const db = new DbHelper(logger);
    await db.connect();
    const seed = new PrepaidSeedHelper(logger);
    const startDate = await seed.ccpDate();

    try {
      // ── step 1: a FREE billing day, so the daily run bills only our account ──
      const free = await db.query<{ d: number }>(
        `SELECT t.d FROM generate_series(2,28) AS t(d) LEFT JOIN core_engine.billing_profile bp
           ON bp.billingdom = t.d AND bp.status = 'ACTIVE' GROUP BY t.d HAVING COUNT(bp.accountid) = 0 ORDER BY t.d`);
      const startDay = Number(startDate.slice(8, 10));
      // Not the creation day: that gives a full-month first cycle (TC-59), and this test wants the bill date soon.
      const bdom = Number(process.env.JASEC_TRUEUP_BDOM) || free.map(f => f.d).find(d => d !== startDay);
      if (blockedIf(!bdom, 'no free billing day (2-28) on this tenant - the daily run would bill other accounts')) return;

      const suffix = uniqueRunSuffix();
      // A QA meter, never the numeric 17-digit device shape (a real-looking meter can reach the live AMI).
      const meter = assertQaMeter(`M-QABIL-${suffix}`);
      const { accountId } = await seed.seed({
        meter, customerId: `E2ETRUEUP-A-${suffix}`, name: `E2ETRUEUP-A ${suffix}`, billingDom: bdom!,
      });
      console.log(`\n  seeded ${accountId} on ${startDate}, billing day ${bdom}`);
      const problems = await new OrderOutcomeHelper(logger).readAndVerify(accountId, { meter, bundleId: 'B-100000-E' });
      expect(problems, 'the seeded contract is not usable').toEqual([]);
      await seed.topUp(accountId, 5000);

      // ── step 2: the bill date of the first cycle (creation -> billing day: a REAL cycle, 0 kWh) ──
      const billUnitId = await pendingBillUnit(db, accountId);
      expect(billUnitId, `${accountId} has no PENDING bill unit`).toBeTruthy();
      const bd = await db.query<{ d: string; s: string; e: string }>(
        `SELECT (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text d,
                bu.startdate::date::text s, bu.enddate::date::text e
           FROM core_engine.billing_profile bp JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid
          WHERE bp.accountid = $1`, [accountId]);
      const billDate = bd[0].d;
      console.log(`  cycle ${bd[0].s} -> ${bd[0].e}, bill date ${billDate}`);
      if (blockedIf(bd[0].s === bd[0].e, `the first cycle has no length (${bd[0].s}) - pick another billing day`)) return;
      const others = await db.query<{ n: number }>(
        `SELECT count(*)::int n FROM core_engine.billing_profile bp
          WHERE bp.accountid <> $1 AND bp.status = 'ACTIVE'
            AND bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid) = $2::date`, [accountId, billDate]);
      if (blockedIf((others[0]?.n ?? 0) > 0, `${others[0].n} other account(s) are also due on ${billDate} - refusing to bill them`)) return;
      const slot = await db.query<{ n: number }>(`SELECT count(*)::int n FROM core_engine.job_schedule WHERE scheduledate::date = $1::date`, [billDate]);
      if (blockedIf((slot[0]?.n ?? 0) > 0, `${billDate} already holds a job schedule - set JASEC_TRUEUP_BDOM to another free day`)) return;

      // ── step 3: the operator's daily billing run, through the Core UI Daily Schedule screen ──
      // (Bills > "Bill Pending charges" is DISABLED for a 0-kWh cycle - verified on preprod 2026-10-06 - so in
      // real life this cycle is closed and invoiced by the daily run, which is what this does.)
      await seed.setCcpDate(billDate);
      const chain = await dailySchedulePage.createAndProcess(billDate, () => seed.setCcpDate(billDate).then(() => undefined), logger);
      console.log(`  Daily Schedule screen: ${Object.entries(chain).map(([k, v]) => `${k}=${v}`).join(' ') || '(none parsed)'}`);
      let closed: any = null;
      for (let i = 0; i < 60 && !(closed && closed.status !== 'PENDING'); i++) {
        closed = (await db.query<any>(`SELECT id, status, total::float8 AS total FROM core_engine.bill_unit WHERE id = $1`, [billUnitId]))[0];
        if (closed?.status === 'PENDING') await page.waitForTimeout(5000);
      }
      console.log(`  bill unit ${billUnitId}: total ${closed?.total}, status ${closed?.status}`);
      expect(closed?.status, `the daily run did not close bill unit ${billUnitId}`).not.toBe('PENDING');

      // ── step 4: on screen first - the bill and its invoice on Core UI Bills ──
      await openBills(page, customerManagementPage, billsPage, accountId);
      const billRow = (await billsPage.openClosedBillRows()).find((r: any) => r['Bill Unit Id'] === billUnitId);
      console.log(`  Core UI Bills: bill unit ${billUnitId} Bill Total "${billRow?.['Bill Total'] ?? 'NOT LISTED'}", ` +
        `invoice "${billRow?.['Invoice Id'] ?? ''}" ${billRow?.['Invoice Status'] ?? ''}`);
      expect.soft(billRow, `Core UI Open/Closed Bills does not list bill unit ${billUnitId}`).toBeTruthy();
      if (billRow) {
        expect.soft(uiAmount(billRow['Bill Total']), `Core UI Bill Total for ${billUnitId}`).toBe(FIXED_CHARGE);
        expect.soft(billRow['Invoice Id'], `Core UI shows no invoice for bill unit ${billUnitId}`).toBeTruthy();
      }

      // ── step 5: the four true-up lines (record) ──
      const lines = await trueUpLines(db, billUnitId);
      console.log('  true-up lines:');
      for (const l of lines) console.log(`    ${l.itemid}  ${String(l.description).padEnd(24)} ${l.netamount}`);
      expect(
        lines.length,
        `a cycle consuming 0 kWh must be trued up with 4 VOLUME_DISCOUNT lines, found ${lines.length}. ` +
        `Zero lines is the zero-length-cycle defect — check the cycle actually has length.`,
      ).toBe(EXPECTED_TRUEUP.length);
      for (const want of EXPECTED_TRUEUP) {
        const got = lines.find((l: any) => l.itemid === want.itemId);
        expect(got, `missing true-up line ${want.itemId} (${want.description})`).toBeTruthy();
        expect.soft(money(got.netamount), `${want.itemId} ${want.description}`).toBe(want.amount);
      }
      expect(
        money(lines.reduce((a: number, l: any) => a + Number(l.netamount), 0)),
        'the four true-up lines must total the monthly fixed charge',
      ).toBe(FIXED_CHARGE);

      // ── step 6: the bill carrying the -17.40 credit must invoice ──
      // The pair - the CVG credit posting as -17.40 AND INVOICE_CHECK accepting the bill - is what the V10_9
      // migration was supposed to fix; 96 bill units with the credit were once never invoiced.
      const invoices = await db.query<any>(
        `SELECT id, status, total::float8 AS total FROM core_engine.invoice_unit WHERE billunitid = $1`, [billUnitId]);
      console.log(`  invoice: ${invoices[0]?.id ?? 'NONE'} (rows: ${invoices.length})`);
      expect(
        invoices.length,
        `bill unit ${billUnitId} carries the -17.40 CVG credit and did NOT invoice. ` +
        `That is the 0-30 kWh / INVOICE_CHECK refusal — the revenue is stranded and can never reach the ERP.`,
      ).toBeGreaterThan(0);

      console.log(`\n  PASS — ${accountId}: trued up to ${FIXED_CHARGE} and invoiced, billed from the Daily Schedule screen\n`);
    } finally {
      await seed.setCcpDate(startDate).catch(e => console.log(`  WARNING: clock not restored to ${startDate}: ${e}`));
      await db.disconnect();
    }
  });

  // TC-59. The agreed rule (JEPYP-319 Q2, Luis, 2026-10-08): a zero-length billing cycle cannot occur in
  // production, because an account created ON its billing day gets a full month - start = creation day,
  // end = the same day next month. (Until 2026-10-08 this test only RECORDED a "same-day cycle"; it could never
  // build one - the seed defaulted to billing day 1 - and the disabled "Bill Pending charges" button it saw came
  // from the 0 kWh, not from the cycle length.)
  test('B — an account created on its billing day gets a full-month first cycle (no zero-length cycle)', { tag: '@tc-59' }, async () => {
    blockedIf(!RUN_ENABLED, 'JASEC_TRUEUP_RUN is not "true".');

    const logger = new TestLogger('ts-10-first-cycle-on-billing-day');
    const db = new DbHelper(logger);
    await db.connect();

    try {
      const seed = new PrepaidSeedHelper(logger);
      const today = await seed.ccpDate();
      const day = Number(today.slice(8, 10));
      if (blockedIf(day > 28, `the clock is on day ${day} - billing days are 1-28 only, so no account can be created on its billing day today`)) return;

      const suffix = uniqueRunSuffix();
      const meter = assertQaMeter(`M-QABIL-${suffix}`);
      const { accountId } = await seed.seed({
        meter, customerId: `E2ETRUEUP-B-${suffix}`, name: `E2ETRUEUP-B ${suffix}`, billingDom: day,
      });
      console.log(`\n  seeded ${accountId} on ${today} with billing day ${day} (its own creation day)`);

      // The cycle is read after creation - nothing is billed and the clock does not move. The first REGULAR
      // bill unit appears a few seconds after the seed returns (it is not linked yet at +0s), so poll for it.
      // 180 s, not 60 s: on dev 2026-10-12 ACT-101332's unit appeared ~2-3 min after the seed (ids 5638-5641
      // skipped), and was then correct (10-20 -> 11-20). The wait is logged so a slow unit stays visible.
      let r: { s: string; e: string; want: string }[] = [];
      const t0 = Date.now();
      for (let i = 0; i < 90 && !r.length; i++) {
        r = await db.query<{ s: string; e: string; want: string }>(
          `SELECT bu.startdate::date::text s, bu.enddate::date::text e,
                  ($2::date + interval '1 month')::date::text want
             FROM core_engine.bill_unit bu
            WHERE bu.accountid = $1 AND bu.type = 'REGULAR'
            ORDER BY bu.id LIMIT 1`, [accountId, today]);
        if (!r.length) await new Promise((res) => setTimeout(res, 2000));
      }
      expect(r[0], `${accountId} has no REGULAR bill unit 180 s after creation`).toBeTruthy();
      console.log(`  first cycle ${r[0].s} -> ${r[0].e} (expected ${today} -> ${r[0].want}); bill unit seen after ${Math.round((Date.now() - t0) / 1000)} s`);
      expect(r[0].e, `${accountId}: a zero-length first cycle (${r[0].s} -> ${r[0].e}) - JEPYP-319 Q2 says it cannot occur`)
        .not.toBe(r[0].s);
      expect(`${r[0].s} -> ${r[0].e}`, `${accountId}: created on its billing day, the first cycle must be one full month`)
        .toBe(`${today} -> ${r[0].want}`);
    } finally {
      await db.disconnect();
    }
  });
});
