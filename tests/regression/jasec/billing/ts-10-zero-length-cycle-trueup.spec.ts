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
 * Two tests, because they need accounts with different cycle lengths:
 *   A  a real cycle   -> the true-up fires, and the bill carrying the -17.40
 *                        CVG credit must also invoice
 *   B  a zero-length  -> no true-up at all. Huy's open question: should a
 *      cycle                same-day cycle still bill the fixed charge?
 *
 * ── MUTATING, AND IT MOVES A SHARED CLOCK ──────────────────────────────────
 * Seeds accounts, MOVES THE TENANT-GLOBAL CCP CLOCK, and bills irreversibly.
 * `runPendingBill` closes the current cycle and opens a new one, so it is only
 * ever called on accounts this spec created. Gated behind JASEC_TRUEUP_RUN=true.
 *
 *     $env:JASEC_TRUEUP_RUN='true'
 *     npx playwright test --project=jasec-billing-trueup
 *
 * Coordinate before running: another session's date-sensitive spec will see the
 * clock move.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { OrderOutcomeHelper } from '../../../../helpers/order-outcome.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';
import { shiftDate } from '../../../../helpers/accounting-gql.helper';

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
  tag: ['@jasec', '@billing', '@trueup', '@tc-58', '@tc-59'],
}, () => {
  test.setTimeout(15 * 60 * 1000);

  test('A — a real cycle under 30 kWh is trued up to the fixed charge, and invoices', async () => {
    blockedIf(
      !RUN_ENABLED,
      'JASEC_TRUEUP_RUN is not "true". This spec moves the TENANT-GLOBAL CCP clock ' +
      'and bills accounts irreversibly, so it never runs by accident.',
    );

    const logger = new TestLogger('ts-10-trueup-real-cycle');
    const db = new DbHelper(logger);
    await db.connect();

    try {
      const seed = new PrepaidSeedHelper(logger);
      const startDate = await seed.ccpDate();
      const suffix = uniqueRunSuffix();
      // A QA meter, never the numeric 17-digit device shape: dev has
      // provisioningEnabled=true, so a real-looking meter can reach the live AMI.
      const meter = assertQaMeter(`M-QABIL-${suffix}`);

      // ── step 1: seed on today's clock ───────────────────────────────
      const { accountId } = await seed.seed({
        meter,
        customerId: `E2ETRUEUP-A-${suffix}`,
        name: `E2ETRUEUP-A ${suffix}`,
      });
      console.log(`\n  seeded ${accountId} on ${startDate}`);

      const problems = await new OrderOutcomeHelper(logger).readAndVerify(accountId, {
        meter, bundleId: 'B-100000-E',
      });
      expect(problems, 'the seeded contract is not usable').toEqual([]);

      await seed.topUp(accountId, 5000);

      // ── step 2: give the cycle real length ──────────────────────────
      /**
       * THE WHOLE POINT. The order cannot be back-dated, so the cycle is given
       * length by moving the clock FORWARD after the account exists. 20 days is
       * comfortably inside the BDOM-1 monthly cycle and leaves the period
       * unambiguous.
       */
      const billDate = shiftDate(startDate, 20);
      await seed.setCcpDate(billDate);
      console.log(`  clock moved ${startDate} -> ${billDate} (cycle is 20 days long)`);

      // ── step 3: close the cycle ─────────────────────────────────────
      const bill = await seed.runPendingBill(accountId);
      expect(bill?.id, 'runPendingBill produced no bill unit').toBeTruthy();
      const billUnitId = bill!.id;
      console.log(`  bill unit ${billUnitId}: total ${bill!.billTotal}, status ${bill!.status}`);

      // ── step 4: the four true-up lines ──────────────────────────────
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
        expect
          .soft(money(got.netamount), `${want.itemId} ${want.description}`)
          .toBe(want.amount);
      }

      expect(
        money(lines.reduce((a: number, l: any) => a + Number(l.netamount), 0)),
        'the four true-up lines must total the monthly fixed charge',
      ).toBe(FIXED_CHARGE);

      // ── step 5: the bill carrying the -17.40 credit must invoice ────
      /**
       * THE ASSERTION THAT MATTERS, in the guide's own words. The pair — the CVG
       * credit posting as -17.40 AND INVOICE_CHECK accepting the bill — is what
       * the V10_9 migration was supposed to fix.
       *
       * It is worth knowing this is contested: the guide's own reference bill
       * unit 4951 carries all four lines and has NO invoice, and the accounting
       * sweep on 2026-09-15 found 96 bill units carrying the -17.40 credit whose
       * revenue never reached the ERP because they were never invoiced. If this
       * fails, that is the finding, not a flake.
       */
      const invoiceId = await seed.invoiceAccount(accountId, billUnitId);
      const invoices = await db.query<any>(
        `SELECT id, status, total::float8 AS total FROM core_engine.invoice_unit WHERE billunitid = $1`,
        [billUnitId],
      );
      console.log(`  invoice: ${invoiceId ?? 'REFUSED'} (rows: ${invoices.length})`);

      expect(
        invoices.length,
        `bill unit ${billUnitId} carries the -17.40 CVG credit and did NOT invoice. ` +
        `That is the 0-30 kWh / INVOICE_CHECK refusal — the revenue is stranded and ` +
        `can never reach the ERP. See the accounting suite's stranded-revenue report.`,
      ).toBeGreaterThan(0);

      console.log(`\n  PASS — ${accountId}: trued up to ${FIXED_CHARGE} and invoiced\n`);
    } finally {
      await db.disconnect();
    }
  });

  test('B — a zero-length cycle produces no true-up at all', async () => {
    blockedIf(!RUN_ENABLED, 'JASEC_TRUEUP_RUN is not "true".');

    const logger = new TestLogger('ts-10-trueup-zero-length');
    const db = new DbHelper(logger);
    await db.connect();

    try {
      const seed = new PrepaidSeedHelper(logger);
      const today = await seed.ccpDate();
      const suffix = uniqueRunSuffix();
      const meter = assertQaMeter(`M-QABIL-${suffix}`);

      const { accountId } = await seed.seed({
        meter,
        customerId: `E2ETRUEUP-B-${suffix}`,
        name: `E2ETRUEUP-B ${suffix}`,
      });
      await seed.topUp(accountId, 5000);
      console.log(`\n  seeded ${accountId} on ${today}, billing the SAME day (cycle length 0)`);

      // No clock move: bill on the creation date, exactly as ACT-100876 was.
      const bill = await seed.runPendingBill(accountId);
      expect(bill?.id, 'runPendingBill produced no bill unit').toBeTruthy();
      const lines = await trueUpLines(db, bill!.id);

      const period = await db.query<any>(
        `SELECT startdate::text AS s, enddate::text AS e FROM core_engine.bill_unit WHERE id = $1`,
        [bill!.id],
      );
      console.log(
        `  bill unit ${bill!.id}: period ${period[0]?.s} -> ${period[0]?.e}, ` +
        `total ${bill!.billTotal}, ${lines.length} true-up line(s)`,
      );

      /**
       * DOCUMENTS THE BEHAVIOUR, does not bless it. Huy's note: "worth a ticket
       * if you think a same-day cycle should still bill the fixed charge."
       *
       * Asserted as-is so the suite NOTICES if it ever changes — if a zero-length
       * cycle starts producing a true-up, that is a deliberate fix and this test
       * should be updated to demand it, not quietly pass.
       */
      expect(
        lines.length,
        `a zero-length cycle currently produces NO true-up. If this now returns 4 lines ` +
        `the behaviour has been changed deliberately — update this test to require it.`,
      ).toBe(0);

      console.log(
        `\n  CONFIRMED — a same-day cycle bills ${bill!.billTotal} with no true-up.\n` +
        `  Open question for the team: should it still bill the ${FIXED_CHARGE} fixed charge?\n`,
      );
    } finally {
      await db.disconnect();
    }
  });
});
