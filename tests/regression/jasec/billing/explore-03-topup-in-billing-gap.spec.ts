/**
 * EXPLORATORY - NOT an official case (no TC number, not in INDEX, not in any runner) until the team decides.
 *
 * Question: do Adrian's billing errors (tracker item 9 a + c, 2026-10-03) come from a top-up made in the GAP
 * between a cycle closing and that cycle being billed?
 *   (a) "Credit Limit 0 ... exceeded by 80.10" on a bill although the account had the money
 *   (c) INVOICE_CHECK "Bill total and invoice total not matched"
 * Lead (dev, 2026-10-05): in every real case the top-up happened after the cycle ended (or on its last day) and
 * before billing - and Adrian's bill 4926 (cycle ended 09-11) holds the 09-19 top-up line RECARGA SALDO
 * ELECTRICIDAD PREPAGO (-10,830, taxcode IVA_BOM). Our tests always top up at cycle START and never saw either error.
 *
 * Design - two fresh accounts, same billing day, same top-up amount, billed in ONE run:
 *   GAP      tops up ON THE BILLING DAY (cycle already closed), just before the run - Adrian's shape
 *   CONTROL  tops up at cycle start - our usual shape, expected clean
 * Reports, per account: balance, the billed bill's lines, job errors, the invoice. Asserts only the harness
 * (the control must bill cleanly; nobody else may be due that day). The finding is in the report.
 *
 * TEST 2 (@topup-refuse-retry): the Option A RECOVERY path - what Adrian's accounts actually were (OUR run-mdr-fixedcharge.sh
 * REFUSE-mode accounts, "QC REFUSE recovery"). Refused for lack of credit, top-up, billing runs again: is the recovered bill
 * INVOICED? AC-102869: the re-bill settled but INVOICE_CHECK failed "not matched". Our REFUSE case never checks the invoice.
 *
 * MUTATING: seeds 2 accounts per test, moves the CCP clock (restored), bills on SCHEDULED (and DAILY for test 2) slots. dev / preprod only.
 *   $env:JASEC_GAP_RUN='true'; $env:JASEC_GAP_BDOM='27'; npx playwright test --project=jasec-billing-explore --grep "@topup-gap"
 */
import { test, expect } from '@playwright/test';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { JobScheduleHelper, type JobType } from '../../../../helpers/job-schedule.helper';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN = String(process.env.JASEC_GAP_RUN ?? '').trim().toLowerCase() === 'true';
const ALLOWED = ['jasec-dev', 'jasec-preprod'].includes(process.env.TEST_ENV ?? '');
const BDOM = Number(process.env.JASEC_GAP_BDOM ?? 27);
const TOP_UP = 10830; // Adrian's amount
const FINAL = ['COMPLETED', 'ERROR'];

test('top-up in the gap between cycle end and billing (exploratory) @topup-gap', async ({ request }) => {
  if (blockedIf(!RUN, 'JASEC_GAP_RUN is not "true" - this seeds, moves the CCP clock and bills')) return;
  if (blockedIf(!ALLOWED, `dev / preprod only (TEST_ENV=${process.env.TEST_ENV})`)) return;
  if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
  test.setTimeout(900_000);

  const seed = new PrepaidSeedHelper();
  const db = new DbHelper();
  await db.connect();
  const startClock = await seed.ccpDate();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    // 1. Two fresh accounts on the same quiet billing day. CONTROL tops up now (cycle start).
    const mk = async (tag: string) => {
      const s = uniqueRunSuffix();
      return (await seed.seed({ meter: assertQaMeter(`M-QA${tag}-${s}`), customerId: `E2E${tag}-${s}`, name: `E2E${tag} ${s}`, billingDom: BDOM })).accountId;
    };
    const gap = await mk('GAP');
    const control = await mk('GAPCTL');
    await seed.topUp(control, TOP_UP);
    console.log(`  seeded GAP ${gap} and CONTROL ${control} on BDOM ${BDOM} at ${startClock}; CONTROL topped up ${TOP_UP} now`);

    // 2. Cycle end + bill date, once both have a PENDING bill unit.
    let rows: Array<{ accountid: string; nad: string; bill: string }> = [];
    for (let i = 0; i < 20; i++) {
      rows = await db.query(
        `SELECT bp.accountid, bp.nextaccountingdate::date::text nad,
                (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text bill
           FROM core_engine.billing_profile bp
           JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
          WHERE bp.accountid = ANY($1)`, [[gap, control]]);
      if (rows.length === 2) break;
      await wait(3_000);
    }
    if (blockedIf(rows.length !== 2 || rows[0].bill !== rows[1].bill, `accounts not ready on one bill date: ${JSON.stringify(rows)}`)) return;
    const { nad: cycleEnd, bill: billDate } = rows[0];

    // Nobody else may be billed by this run.
    const others = await db.query<{ n: number }>(
      `SELECT count(DISTINCT bp.accountid)::int n FROM core_engine.billing_profile bp
         JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
        WHERE bp.accountid <> ALL($1) AND bp.nextaccountingdate = $2::date - core_engine.get_future_cycle_date(bp.accountid)`,
      [[gap, control], billDate]);
    if (blockedIf((others[0]?.n ?? 0) > 0, `${others[0].n} other account(s) are due on ${billDate} - refusing to bill them`)) return;
    console.log(`  cycle ends ${cycleEnd}, billed on ${billDate}; no other account due that day`);

    // 3. Clock to the BILLING DAY (cycle closed), GAP tops up there - Adrian's shape.
    await seed.setCcpDate(billDate);
    await seed.topUp(gap, TOP_UP);
    for (let i = 0; i < 20 && (await db.getTopUpCount(gap)) === 0; i++) await wait(3_000);
    console.log(`  GAP ${gap} topped up ${TOP_UP} on ${billDate} (after its cycle closed on ${cycleEnd})`);

    const balance = async (a: string) => (await db.query<{ v: string }>(
      `SELECT bub.amount::text v FROM core_engine.balance_unit bu JOIN core_engine.balance_unit_balances bub ON bub.id = bu.id
        WHERE bu.accountid = $1 AND bub.currencyid = 'CRC'`, [a]))[0]?.v ?? '?';
    const balBefore = { [gap]: await balance(gap), [control]: await balance(control) };

    // 4. Bill with the tenant's own DAILY billing jobs; wait until every job is final.
    const daily = await db.query<{ jobname: string }>(
      `SELECT jobname FROM (SELECT DISTINCT ON (jobname) jobname, index FROM core_config.config_job_list
                             WHERE id LIKE '%-JOB-DAILY' AND jobname ~ '^(BILL|INVOICE)' ORDER BY jobname, index) t ORDER BY index`);
    const jobs = new JobScheduleHelper(request);
    const scheduleId = await jobs.createSchedule({
      scheduleDate: billDate, frequency: 'SCHEDULED', jobs: daily.map(d => ({ type: d.jobname as JobType })),
    });
    await jobs.processSchedule(scheduleId, 600_000).catch(e => console.log(`  process call: ${String(e).slice(0, 160)}`));
    let states: Array<{ type: string; status: string }> = [];
    for (let i = 0; i < 96; i++) {
      await wait(5_000);
      states = await db.query(`SELECT type, coalesce(status,'') status FROM core_engine.job_schedule_list WHERE id = $1 ORDER BY index`, [scheduleId]);
      if (states.length && states.every(x => FINAL.includes(x.status))) break;
    }
    console.log(`  ${scheduleId}: ${states.map(x => `${x.type}=${x.status}`).join(' ')}`);

    // 5. Report per account.
    const report: Record<string, { errors: string[]; invoiced: boolean; recargaInBill: boolean }> = {};
    for (const [label, a] of [['GAP', gap], ['CONTROL', control]] as const) {
      const bu = (await db.query<{ id: string; status: string; total: string }>(
        `SELECT id, status, billtotal::text total FROM core_engine.bill_unit WHERE accountid = $1 AND enddate::date = $2::date`, [a, cycleEnd]))[0];
      const lines = bu ? await db.query<{ description: string; net: string; taxcode: string; d: string }>(
        `SELECT description, netamount::text net, coalesce(taxcode,'') taxcode, startdate::date::text d
           FROM core_engine.transaction_unit WHERE billunitid = $1 ORDER BY id`, [bu.id]) : [];
      const errs = await db.query<{ type: string; reason: string }>(
        `SELECT l.type, left(coalesce(e.reason,''),100) reason FROM core_engine.jobs_error e
           JOIN core_engine.job_schedule_list l ON l.jobid = e.id WHERE l.id = $1 AND e.accountid = $2`, [scheduleId, a]);
      const inv = bu ? await db.query<{ id: string; total: string; due: string; status: string }>(
        `SELECT id, total::text, due::text, status FROM core_engine.invoice_unit WHERE billunitid = $1`, [bu.id]) : [];
      report[label] = {
        errors: errs.map(e => `${e.type}: ${e.reason}`),
        invoiced: inv.length > 0,
        recargaInBill: lines.some(l => /RECARGA/i.test(l.description)),
      };
      console.log(`\n  ${label} ${a}: balance before run ${balBefore[a]}, after ${await balance(a)}`);
      console.log(`    bill ${bu?.id ?? '-'} (cycle to ${cycleEnd}) ${bu?.status ?? '-'} total ${bu?.total ?? '-'}`);
      for (const l of lines) console.log(`      ${l.description.padEnd(36)} ${l.net.padStart(14)}  ${l.taxcode.padEnd(8)} ${l.d}`);
      console.log(`    job errors: ${report[label].errors.join(' | ') || 'none'}`);
      console.log(`    invoice: ${inv.map(i => `${i.id} total ${i.total} due ${i.due} ${i.status}`).join(', ') || 'NONE'}`);
    }

    const g = report.GAP;
    console.log('\n  FINDINGS (GAP vs CONTROL):');
    console.log(`    top-up made after cycle end landed in the CLOSED cycle's bill: ${g.recargaInBill ? 'YES' : 'no'}`);
    console.log(`    (a) credit-limit refusal although ${TOP_UP} credit was there: ${g.errors.some(e => /credit limit/i.test(e)) ? 'REPRODUCED' : 'not reproduced'}`);
    console.log(`    (c) INVOICE_CHECK "not matched": ${g.errors.some(e => /not matched/i.test(e)) ? 'REPRODUCED' : 'not reproduced'}`);
    console.log(`    GAP invoiced: ${g.invoiced ? 'yes' : 'NO'}; CONTROL clean: ${report.CONTROL.errors.length === 0 && report.CONTROL.invoiced ? 'yes' : 'NO'}`);

    // Harness only: if the control is not clean, the comparison means nothing.
    expect(report.CONTROL.errors, `CONTROL ${control} hit job errors - the comparison is void`).toEqual([]);
    expect(report.CONTROL.invoiced, `CONTROL ${control} was not invoiced - the comparison is void`).toBe(true);
  } finally {
    await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
    await db.disconnect();
  }
});

/** Shared: wait until every job of a schedule is final. */
async function waitFinal(db: DbHelper, scheduleId: string): Promise<Array<{ type: string; status: string }>> {
  let states: Array<{ type: string; status: string }> = [];
  for (let i = 0; i < 96; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    states = await db.query(`SELECT type, coalesce(status,'') status FROM core_engine.job_schedule_list WHERE id = $1 ORDER BY index`, [scheduleId]);
    if (states.length && states.every(x => FINAL.includes(x.status))) break;
  }
  return states;
}

test('refused, topped up, re-billed: is the recovered bill invoiced? (exploratory) @topup-refuse-retry', async ({ request }) => {
  if (blockedIf(!RUN, 'JASEC_GAP_RUN is not "true" - this seeds, moves the CCP clock and bills')) return;
  if (blockedIf(!ALLOWED, `dev / preprod only (TEST_ENV=${process.env.TEST_ENV})`)) return;
  if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
  test.setTimeout(900_000);
  const seed = new PrepaidSeedHelper();
  const db = new DbHelper();
  await db.connect();
  const startClock = await seed.ccpDate();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    const mk = async (tag: string) => {
      const s = uniqueRunSuffix();
      return (await seed.seed({ meter: assertQaMeter(`M-QA${tag}-${s}`), customerId: `E2E${tag}-${s}`, name: `E2E${tag} ${s}`, billingDom: BDOM })).accountId;
    };
    const refuse = await mk('RFR');
    const control = await mk('RFRCTL');
    await seed.topUp(control, TOP_UP);
    console.log(`  seeded REFUSE ${refuse} (balance 0) and CONTROL ${control} (topped up ${TOP_UP}) on BDOM ${BDOM} at ${startClock}`);

    let rows: Array<{ accountid: string; nad: string; bill: string }> = [];
    for (let i = 0; i < 20; i++) {
      rows = await db.query(
        `SELECT bp.accountid, bp.nextaccountingdate::date::text nad,
                (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text bill
           FROM core_engine.billing_profile bp
           JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
          WHERE bp.accountid = ANY($1)`, [[refuse, control]]);
      if (rows.length === 2) break;
      await wait(3_000);
    }
    if (blockedIf(rows.length !== 2 || rows[0].bill !== rows[1].bill, `accounts not ready on one bill date: ${JSON.stringify(rows)}`)) return;
    const { nad: cycleEnd, bill: billDate } = rows[0];
    const others = await db.query<{ n: number }>(
      `SELECT count(DISTINCT bp.accountid)::int n FROM core_engine.billing_profile bp
         JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
        WHERE bp.accountid <> ALL($1) AND bp.nextaccountingdate = $2::date - core_engine.get_future_cycle_date(bp.accountid)`,
      [[refuse, control], billDate]);
    if (blockedIf((others[0]?.n ?? 0) > 0, `${others[0].n} other account(s) are due on ${billDate} - refusing to bill them`)) return;
    const slots = await db.query<{ f: string }>(`SELECT schedulefrequency f FROM core_engine.job_schedule WHERE scheduledate::date = $1::date`, [billDate]);
    if (blockedIf(slots.length > 0, `${billDate} already has schedule(s) (${slots.map(x => x.f).join(',')}) - two free slots are needed`)) return;
    console.log(`  cycle ends ${cycleEnd}, billed on ${billDate}; no other account due; both slots free`);

    await seed.setCcpDate(billDate);
    const daily = await db.query<{ jobname: string }>(
      `SELECT jobname FROM (SELECT DISTINCT ON (jobname) jobname, index FROM core_config.config_job_list
                             WHERE id LIKE '%-JOB-DAILY' AND jobname ~ '^(BILL|INVOICE)' ORDER BY jobname, index) t ORDER BY index`);
    const jobSpecs = daily.map(d => ({ type: d.jobname as JobType }));
    const jobs = new JobScheduleHelper(request);

    // Run 1: REFUSE has no credit -> refused; CONTROL billed.
    const run1 = await jobs.createSchedule({ scheduleDate: billDate, frequency: 'SCHEDULED', jobs: jobSpecs });
    await jobs.processSchedule(run1, 600_000).catch(() => { });
    console.log(`  run 1 ${run1}: ${(await waitFinal(db, run1)).map(x => `${x.type}=${x.status}`).join(' ')}`);

    // Recovery: REFUSE tops up, then run 2 re-bills it.
    await seed.topUp(refuse, TOP_UP);
    for (let i = 0; i < 20 && (await db.getTopUpCount(refuse)) === 0; i++) await wait(3_000);
    const run2 = await jobs.createSchedule({ scheduleDate: billDate, frequency: 'DAILY', jobs: jobSpecs });
    await jobs.processSchedule(run2, 600_000).catch(() => { });
    console.log(`  REFUSE topped up ${TOP_UP}; run 2 ${run2}: ${(await waitFinal(db, run2)).map(x => `${x.type}=${x.status}`).join(' ')}`);

    const report: Record<string, { errors: string[]; invoiced: boolean; buStatus: string }> = {};
    for (const [label, a] of [['REFUSE', refuse], ['CONTROL', control]] as const) {
      const bu = (await db.query<{ id: string; status: string; total: string }>(
        `SELECT id, status, billtotal::text total FROM core_engine.bill_unit WHERE accountid = $1 AND enddate::date = $2::date`, [a, cycleEnd]))[0];
      const lines = bu ? await db.query<{ description: string; net: string; taxcode: string }>(
        `SELECT description, netamount::text net, coalesce(taxcode,'') taxcode FROM core_engine.transaction_unit WHERE billunitid = $1 ORDER BY id`, [bu.id]) : [];
      const errs = await db.query<{ run: string; type: string; reason: string }>(
        `SELECT l.id run, l.type, left(coalesce(e.reason,''),100) reason FROM core_engine.jobs_error e
           JOIN core_engine.job_schedule_list l ON l.jobid = e.id WHERE l.id = ANY($1) AND e.accountid = $2`, [[run1, run2], a]);
      const inv = bu ? await db.query<{ id: string; total: string; due: string; status: string }>(
        `SELECT id, total::text, due::text, status FROM core_engine.invoice_unit WHERE billunitid = $1`, [bu.id]) : [];
      report[label] = { errors: errs.map(e => `${e.run} ${e.type}: ${e.reason}`), invoiced: inv.length > 0, buStatus: bu?.status ?? '-' };
      console.log(`\n  ${label} ${a}: bill ${bu?.id ?? '-'} ${bu?.status ?? '-'} total ${bu?.total ?? '-'}`);
      for (const l of lines) console.log(`      ${l.description.padEnd(36)} ${l.net.padStart(14)}  ${l.taxcode}`);
      console.log(`    job errors: ${report[label].errors.join(' | ') || 'none'}`);
      console.log(`    invoice: ${inv.map(i => `${i.id} total ${i.total} due ${i.due} ${i.status}`).join(', ') || 'NONE'}`);
    }
    const r = report.REFUSE;
    console.log('\n  FINDINGS:');
    console.log(`    run 1 refused REFUSE for credit limit (expected, balance 0): ${r.errors.some(e => e.startsWith(run1) && /credit limit/i.test(e)) ? 'yes' : 'NO'}`);
    console.log(`    run 2 settled the recovered bill: ${r.buStatus !== 'PENDING' ? 'yes' : 'NO'}`);
    console.log(`    (c) INVOICE_CHECK "not matched" after recovery: ${r.errors.some(e => /not matched/i.test(e)) ? 'REPRODUCED' : 'not reproduced'}`);
    console.log(`    recovered bill invoiced: ${r.invoiced ? 'yes' : 'NO'}; CONTROL clean: ${report.CONTROL.errors.length === 0 && report.CONTROL.invoiced ? 'yes' : 'NO'}`);
    expect(report.CONTROL.errors, `CONTROL ${control} hit job errors - the comparison is void`).toEqual([]);
    expect(report.CONTROL.invoiced, `CONTROL ${control} was not invoiced - the comparison is void`).toBe(true);
  } finally {
    await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
    await db.disconnect();
  }
});
