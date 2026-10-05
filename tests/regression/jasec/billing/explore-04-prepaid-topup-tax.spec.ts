/**
 * EXPLORATORY - NOT an official case (no TC number, not in INDEX, not in any runner).
 *
 * R1 (pick-up list): is a prepaid TOP-UP taxed at billing when IVA applies?
 * Huy, preprod 2026-10-03: "the top-up item (RECARGA SALDO ELECTRICIDAD PREPAGO) is set as taxable, so top-ups made
 * inside the cycle get IVA and ICB at billing. JASEC-20260920-013 and -014 even got negative invoices." The top-up
 * line does carry taxcode IVA_BOM on prepaid bills. Our billing tests are all < 30 kWh, where no IVA applies, so tax
 * never touched that line. A prepaid customer > 280 kWh who tops up in-cycle has never been tested.
 *
 * One fresh account: top up 60,000 (funds the usage; sits inside the cycle), baseline reading 1,000 (first reading of
 * a meter with no starting reading = baseline, billed 0), then 1,350 -> 350 kWh (IVA 13% + ICB 1.75% band). Bill it.
 * Report the bill's tax against two expectations:
 *   CORRECT  tax on the energy lines only (ENERGIA + CVG ENERGIA + CVG ALUMBRADO; ALUMBRADO is untaxed)
 *   SUSPECT  the same plus tax on the -60,000 top-up line
 * Asserts only the harness (the usage rated, the bill ran, nobody else was due). The finding is in the report.
 *
 * MUTATING: seeds 1 account, MDR readings, moves the CCP clock (restored), bills on a SCHEDULED slot. dev / preprod.
 *   $env:JASEC_R1_RUN='true'; $env:JASEC_R1_BDOM='25'; npx playwright test --project=jasec-billing-explore --grep "@topup-tax"
 */
import { test, expect } from '@playwright/test';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { JobScheduleHelper, type JobType } from '../../../../helpers/job-schedule.helper';
import { MdrRemoteHelper } from '../../../../helpers/mdr-remote.helper';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN = String(process.env.JASEC_R1_RUN ?? '').trim().toLowerCase() === 'true';
const ALLOWED = ['jasec-dev', 'jasec-preprod'].includes(process.env.TEST_ENV ?? '');
const BDOM = Number(process.env.JASEC_R1_BDOM ?? 25);
const TOP_UP = 60000;
const BASELINE = 1000;
const KWH = 350;
const IVA = 0.13;
const ICB = 0.0175;
const FINAL = ['COMPLETED', 'ERROR'];

test('prepaid top-up taxed at billing when IVA applies? (exploratory) @topup-tax', async ({ request }) => {
  if (blockedIf(!RUN, 'JASEC_R1_RUN is not "true" - this seeds, sends MDR readings, moves the CCP clock and bills')) return;
  if (blockedIf(!ALLOWED, `dev / preprod only (TEST_ENV=${process.env.TEST_ENV})`)) return;
  if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
  test.setTimeout(1_200_000);

  const seed = new PrepaidSeedHelper();
  const mdr = new MdrRemoteHelper();
  const db = new DbHelper();
  await db.connect();
  const startClock = await seed.ccpDate();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    if (blockedIf(!(await mdr.isAvailable()), 'MDR loader tree unreachable or wired to another tenant')) return;

    // 1. Account, top-up, readings.
    const s = uniqueRunSuffix();
    const meter = assertQaMeter(`M-QATAX-${s}`);
    const { accountId } = await seed.seed({ meter, customerId: `E2ETAX-${s}`, name: `E2ETAX ${s}`, billingDom: BDOM });
    await seed.topUp(accountId, TOP_UP);
    for (let i = 0; i < 20 && (await db.getTopUpCount(accountId)) === 0; i++) await wait(3_000);
    console.log(`  seeded ${accountId} meter ${meter} on BDOM ${BDOM} at ${startClock}; topped up ${TOP_UP}`);

    const processedCount = async () => Number((await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND status = 'PROCESSED'`, [meter]))[0]?.n ?? 0);
    await mdr.submitReading(meter, BASELINE);
    for (let i = 0; i < 30 && (await processedCount()) < 1; i++) await wait(5_000);
    await wait(60_000); // the next reading must be stamped after the baseline
    await mdr.submitReading(meter, BASELINE + KWH);
    for (let i = 0; i < 30 && (await processedCount()) < 2; i++) await wait(5_000);
    const rated = await processedCount();
    const parked = await db.query<{ status: string; errorcode: string }>(
      `SELECT status, coalesce(errorcode,'') errorcode FROM core_usage.file_detail_record WHERE provisioningid = $1`, [meter]);
    console.log(`  readings ${BASELINE} then ${BASELINE + KWH}: ${rated} PROCESSED${parked.length ? `; not processed: ${JSON.stringify(parked)}` : ''}`);
    if (blockedIf(rated < 2, `the usage did not rate (${rated}/2 processed) - nothing to bill`)) return;

    // 2. Bill date; nobody else due.
    let row: { nad: string; bill: string } | undefined;
    for (let i = 0; i < 20 && !row; i++) {
      row = (await db.query<{ nad: string; bill: string }>(
        `SELECT bp.nextaccountingdate::date::text nad, (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text bill
           FROM core_engine.billing_profile bp JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
          WHERE bp.accountid = $1`, [accountId]))[0];
      if (!row) await wait(3_000);
    }
    if (blockedIf(!row, `${accountId} has no PENDING bill unit`)) return;
    const others = await db.query<{ n: number }>(
      `SELECT count(DISTINCT bp.accountid)::int n FROM core_engine.billing_profile bp
         JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
        WHERE bp.accountid <> $1 AND bp.nextaccountingdate = $2::date - core_engine.get_future_cycle_date(bp.accountid)`, [accountId, row!.bill]);
    if (blockedIf((others[0]?.n ?? 0) > 0, `${others[0].n} other account(s) due on ${row!.bill} - refusing to bill them`)) return;
    console.log(`  cycle ends ${row!.nad}, billed on ${row!.bill}; no other account due`);

    // 3. Bill with the tenant's own DAILY billing jobs.
    await seed.setCcpDate(row!.bill);
    const daily = await db.query<{ jobname: string }>(
      `SELECT jobname FROM (SELECT DISTINCT ON (jobname) jobname, index FROM core_config.config_job_list
                             WHERE id LIKE '%-JOB-DAILY' AND jobname ~ '^(BILL|INVOICE)' ORDER BY jobname, index) t ORDER BY index`);
    const jobs = new JobScheduleHelper(request);
    const scheduleId = await jobs.createSchedule({ scheduleDate: row!.bill, frequency: 'SCHEDULED', jobs: daily.map(d => ({ type: d.jobname as JobType })) });
    await jobs.processSchedule(scheduleId, 600_000).catch(() => { });
    let states: Array<{ type: string; status: string }> = [];
    for (let i = 0; i < 96; i++) {
      await wait(5_000);
      states = await db.query(`SELECT type, coalesce(status,'') status FROM core_engine.job_schedule_list WHERE id = $1 ORDER BY index`, [scheduleId]);
      if (states.length && states.every(x => FINAL.includes(x.status))) break;
    }
    console.log(`  ${scheduleId}: ${states.map(x => `${x.type}=${x.status}`).join(' ')}`);

    // 4. What was billed and taxed.
    const bu = (await db.query<{ id: string; status: string; total: string }>(
      `SELECT id, status, billtotal::text total FROM core_engine.bill_unit WHERE accountid = $1 AND enddate::date = $2::date`, [accountId, row!.nad]))[0];
    const lines = bu ? await db.query<{ description: string; type: string; net: number; taxcode: string }>(
      `SELECT description, type, netamount::float8 net, coalesce(taxcode,'') taxcode FROM core_engine.transaction_unit WHERE billunitid = $1 ORDER BY id`, [bu.id]) : [];
    const errs = await db.query<{ type: string; reason: string }>(
      `SELECT l.type, left(coalesce(e.reason,''),110) reason FROM core_engine.jobs_error e
         JOIN core_engine.job_schedule_list l ON l.jobid = e.id WHERE l.id = $1 AND e.accountid = $2`, [scheduleId, accountId]);
    const inv = bu ? await db.query<{ id: string; total: number; due: number; status: string }>(
      `SELECT id, total::float8 total, due::float8 due, status FROM core_engine.invoice_unit WHERE billunitid = $1`, [bu.id]) : [];
    // Tax detail per item, computed at billing: the direct evidence of WHAT was taxed.
    const taxRows = bu ? await db.query<{ itemid: string; name: string; taxable: number; amount: number; rate: string }>(
      `SELECT coalesce(itemid,'') itemid, coalesce(name,'') name, coalesce(taxableamount,0)::float8 taxable,
              coalesce(amount,0)::float8 amount, coalesce(taxrate::text,'') rate
         FROM core_engine.invoice_tax_detail WHERE billunitid = $1 ORDER BY itemid, name`, [bu.id]) : [];

    const isTax = (l: { description: string; type: string }) => /tax/i.test(l.description) || /TAX/.test(l.type);
    const charges = lines.filter(l => !isTax(l));
    const taxLines = lines.filter(isTax);
    const base = charges.filter(l => /^(ENERGIA|CVG ENERGIA|CVG ALUMBRADO PUBLICO)$/i.test(l.description)).reduce((a, l) => a + l.net, 0);
    const recarga = charges.filter(l => /RECARGA/i.test(l.description)).reduce((a, l) => a + l.net, 0);
    const billTax = taxRows.length ? taxRows.reduce((a, r) => a + r.amount, 0) : taxLines.reduce((a, l) => a + l.net, 0);
    const topupTaxRows = taxRows.filter(r => r.itemid === 'I-100007');
    const rate = IVA + ICB;
    const expCorrect = base * rate;
    const expSuspect = (base + recarga) * rate;

    console.log(`\n  bill ${bu?.id ?? '-'} ${bu?.status ?? '-'} total ${bu?.total ?? '-'}:`);
    for (const l of lines) console.log(`      ${l.description.padEnd(36)} ${l.net.toFixed(2).padStart(12)}  ${l.taxcode.padEnd(8)} ${l.type}`);
    console.log(`    job errors: ${errs.map(e => `${e.type}: ${e.reason}`).join(' | ') || 'none'}`);
    console.log(`    invoice: ${inv.map(i => `${i.id} total ${i.total} due ${i.due} ${i.status}`).join(', ') || 'NONE'}`);
    console.log(`    tax detail rows (item / tax / taxable / amount / rate):`);
    for (const r of taxRows) console.log(`      ${r.itemid.padEnd(9)} ${r.name.padEnd(10)} ${r.taxable.toFixed(2).padStart(12)} ${r.amount.toFixed(2).padStart(10)}  ${r.rate}`);
    console.log(`\n  TAX CHECK (IVA ${IVA * 100}% + ICB ${ICB * 100}% at ${KWH} kWh):`);
    console.log(`    taxable energy base ${base.toFixed(2)}; top-up line ${recarga.toFixed(2)}`);
    console.log(`    tax on the bill            ${billTax.toFixed(2)}`);
    console.log(`    CORRECT (energy only)      ${expCorrect.toFixed(2)}`);
    console.log(`    SUSPECT (incl. top-up)     ${expSuspect.toFixed(2)}`);
    const near = (a: number, b: number) => Math.abs(a - b) < Math.max(1, Math.abs(b) * 0.02);
    const verdict = near(billTax, expCorrect) ? 'top-up NOT taxed (correct)'
      : near(billTax, expSuspect) ? 'TOP-UP TAXED - tax reduced by the top-up line (defect)'
      : 'neither - investigate (tax rules may differ from the flat rates used here)';
    console.log(`    -> ${verdict}`);
    console.log(`    tax rows computed ON the top-up item I-100007: ${topupTaxRows.length ? `YES (${topupTaxRows.map(r => r.amount.toFixed(2)).join(', ')})` : 'none'}`);
    if (inv.length && inv[0].total < 0) console.log('    -> NEGATIVE INVOICE');

    // Harness only.
    expect(bu, 'no bill unit for the cycle - the run did not bill').toBeTruthy();
    expect(bu!.status, `bill unit ${bu!.id} still PENDING - not billed (errors: ${errs.map(e => e.reason).join('; ')})`).not.toBe('PENDING');
  } finally {
    await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
    await db.disconnect();
  }
});
