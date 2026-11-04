/**
 * SEEDING, not a test of the product: one fresh prepaid invoice per HIGH consumption band, so the invoice band checks
 * (billing/ts-01-invoice-bands, TC-135..141) have something to judge on a tenant that never billed that much. Preprod
 * (2026-10-21) had no prepaid invoice in the 1751-50000 kWh and 50001+ kWh bands, so those bands always reported
 * BLOCKED; the RATING of such readings is already proven by the tariff calculation cases (TC47 1000 kWh, TC48 20000 kWh).
 *
 * Per band: a fresh account on a free billing day (helpers/free-billing-day.helper.ts - seeds until the account's real
 * bill date has no daily run), a top-up that covers the bill, a baseline reading (billed 0) then baseline + kWh, and the
 * tenant's own DAILY billing jobs on the bill date (as explore-04). Asserts the bill and the invoice exist; the band
 * check itself is ts-01's job - run `jasec-billing-read` after this.
 *
 * MUTATING: seeds accounts, MDR readings, moves the CCP clock, bills on a SCHEDULED slot. dev / preprod.
 *   $env:JASEC_BAND_SEED_RUN='true'; npx playwright test --project=jasec-seed seed-band-invoices
 *   optional JASEC_BAND_KWH='2000,60000' (default: one per high band)
 */
import { test, expect } from '@playwright/test';
import { PrepaidSeedHelper } from '../../../helpers/prepaid-seed.helper';
import { JobScheduleHelper, type JobType } from '../../../helpers/job-schedule.helper';
import { MdrRemoteHelper } from '../../../helpers/mdr-remote.helper';
import { DbHelper, hasDbConfig } from '../../../helpers/db.helper';
import { uniqueRunSuffix, assertQaMeter } from '../../../fixtures/create-prepaid-account.helper';
import { seedOnFreeBillDate } from '../../../helpers/free-billing-day.helper';
import { blockedIf } from '../../../helpers/blocked.helper';
import { sleep } from '../../../helpers/poll.helper';
import { CLOCK_RESTORE } from '../../../helpers/clock-policy';

const RUN = String(process.env.JASEC_BAND_SEED_RUN ?? '').trim().toLowerCase() === 'true';
const ALLOWED = ['jasec-dev', 'jasec-preprod', 'jasec-oci-dev'].includes(process.env.TEST_ENV ?? '');
const KWHS = String(process.env.JASEC_BAND_KWH ?? '2000,60000').split(',').map(x => Number(x.trim())).filter(n => n > 0);
const BASELINE = 1000;
/** Covers ENERGIA + CVG + ALP + taxes with room to spare (~90 CRC/kWh at the top block). */
const CRC_PER_KWH = 110;
const FINAL = ['COMPLETED', 'ERROR'];

for (const kwh of KWHS) {
  test(`seed a billed prepaid invoice of ${kwh} kWh @seed-band-invoice`, async ({ request }) => {
    if (blockedIf(!RUN, 'JASEC_BAND_SEED_RUN is not "true" - this seeds, sends MDR readings, moves the CCP clock and bills')) return;
    if (blockedIf(!ALLOWED, `dev / preprod / oci-dev only (TEST_ENV=${process.env.TEST_ENV})`)) return;
    if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
    test.setTimeout(1_800_000);

    const seed = new PrepaidSeedHelper();
    const mdr = new MdrRemoteHelper();
    const db = new DbHelper();
    await db.connect();
    const startClock = await seed.ccpDate();
    try {
      if (blockedIf(!(await mdr.isAvailable()), 'MDR loader tree unreachable or wired to another tenant')) return;

      // 1. Account on a free billing day.
      const meters: Record<string, string> = {};
      const got = await seedOnFreeBillDate(db, { read: () => seed.ccpDate(), set: d => seed.setCcpDate(d) }, async (day) => {
        const s = uniqueRunSuffix();
        const meter = assertQaMeter(`M-QABAND-${s}`);
        const { accountId } = await seed.seed({ meter, customerId: `E2EBAND-${s}`, name: `E2EBAND ${s}`, billingDom: day });
        meters[accountId] = meter;
        return accountId;
      });
      if (blockedIf(!got, 'no billing day gives a bill date without a daily run')) return;
      const { accountId, billDate } = got!;
      const meter = meters[accountId];
      const topUp = Math.ceil(kwh * CRC_PER_KWH / 1000) * 1000;
      await seed.topUp(accountId, topUp);
      for (let i = 0; i < 20 && (await db.getTopUpCount(accountId)) === 0; i++) await sleep(3_000);
      console.log(`  ${kwh} kWh: seeded ${accountId} meter ${meter}, bill date ${billDate}; topped up ${topUp}`);

      // 2. Baseline, then the consumption.
      const processed = async () => Number((await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND status = 'PROCESSED'`, [meter]))[0]?.n ?? 0);
      await mdr.submitReading(meter, BASELINE);
      for (let i = 0; i < 30 && (await processed()) < 1; i++) await sleep(5_000);
      await sleep(60_000); // the next reading must be stamped after the baseline
      await mdr.submitReading(meter, BASELINE + kwh);
      for (let i = 0; i < 36 && (await processed()) < 2; i++) await sleep(5_000);
      const rated = await processed();
      if (blockedIf(rated < 2, `the usage did not rate (${rated}/2 processed) - nothing to bill`)) return;

      // 3. Bill with the tenant's own DAILY billing jobs, on the bill date.
      await seed.setCcpDate(billDate);
      const daily = await db.query<{ jobname: string }>(
        `SELECT jobname FROM (SELECT DISTINCT ON (jobname) jobname, index FROM core_config.config_job_list
                               WHERE id LIKE '%-JOB-DAILY' AND jobname ~ '^(BILL|INVOICE)' ORDER BY jobname, index) t ORDER BY index`);
      const jobs = new JobScheduleHelper(request);
      const scheduleId = await jobs.createSchedule({ scheduleDate: billDate, frequency: 'SCHEDULED', jobs: daily.map(d => ({ type: d.jobname as JobType })) });
      await jobs.processSchedule(scheduleId, 600_000).catch(() => { });
      let states: Array<{ type: string; status: string }> = [];
      for (let i = 0; i < 120; i++) {
        await sleep(5_000);
        states = await db.query(`SELECT type, coalesce(status,'') status FROM core_engine.job_schedule_list WHERE id = $1 ORDER BY index`, [scheduleId]);
        if (states.length && states.every(x => FINAL.includes(x.status))) break;
      }
      console.log(`  ${scheduleId}: ${states.map(x => `${x.type}=${x.status}`).join(' ')}`);

      // 4. The bill and the invoice exist.
      const inv = await db.query<{ id: string; total: number }>(
        `SELECT iu.id, iu.total::float8 total FROM core_engine.invoice_unit iu WHERE iu.accountid = $1 ORDER BY iu.id DESC LIMIT 1`, [accountId]);
      console.log(`  ${kwh} kWh: invoice ${inv[0]?.id ?? '<none>'} total ${inv[0]?.total ?? '-'} (band: billing/ts-01 judges it)`);
      expect(inv.length, `${accountId}: no invoice after the billing run ${scheduleId}`).toBe(1);
    } finally {
      if (CLOCK_RESTORE) await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
      await db.disconnect().catch(() => { });
    }
  });
}
