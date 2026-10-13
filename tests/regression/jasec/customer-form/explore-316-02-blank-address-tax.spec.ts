/**
 * EXPLORATORY - NOT an official case (no TC number, not in INDEX). JEPYP-316 charter rows 6.3 / 6.4.
 *
 * Question: now that every address field is optional, is a customer with a blank Cantón (or a blank address) still
 * charged IVA 13% + ICB 1.75% at billing? The tax engine rejects a blank city / state / postal code / country, and
 * billing reads that refusal the same way as "no tax applies" (design doc, finding 5). The tax-engine bypass MR (!74)
 * was REVERTED on 2026-10-13, so what fills the blanks - if anything - is unknown (Huy Q3). This measures it.
 *
 * Three fresh accounts on ONE free bill date, each 350 kWh (IVA + ICB band), each topped up 60,000 so the bill is
 * not refused for credit (explore-08):
 *   K control      full address                 Avenida 2 Occidental / Cartago / Cartago / CRI / 30101
 *   C no Cantón    city '' and district ''       (charter 6.3)
 *   B all blank    street/city/state/postal ''   country CRI (what the form saves, F2)   (charter 6.4)
 * For each: the taxable energy base, the tax computed on it, the invoice. Verdict per account:
 *   TAXED      tax ~= base x (IVA + ICB), as the control
 *   NOT TAXED  tax ~= 0 -> defect (silent zero IVA)
 * Asserts only the harness (usage rated, bill ran, nobody else due). The finding is in the report.
 *
 * MUTATING: seeds 3 accounts, MDR readings, moves the CCP clock (restored), bills on a SCHEDULED slot of a free date.
 * dev / preprod only.
 *   $env:JEPYP316_TAX_RUN='true'; $env:JEPYP316_TAX_BDOM='26'
 *   npx playwright test --project=jasec-customer-form-explore --grep "@316-tax"
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { JobScheduleHelper, type JobType } from '../../../../helpers/job-schedule.helper';
import { MdrRemoteHelper } from '../../../../helpers/mdr-remote.helper';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN = String(process.env.JEPYP316_TAX_RUN ?? '').trim().toLowerCase() === 'true';
const ENV = process.env.TEST_ENV ?? '';
const ALLOWED = ['jasec-dev', 'jasec-preprod'].includes(ENV);
const BDOM = Number(process.env.JEPYP316_TAX_BDOM ?? 26);
const TOP_UP = 60000;
const BASELINE = 1000;
const KWH = 350;
const IVA = 0.13;
const ICB = 0.0175;
const FINAL = ['COMPLETED', 'ERROR'];
const EVIDENCE = process.env.JEPYP316_EVIDENCE_DIR ?? path.resolve(__dirname,
  `../../../../../../Regression testing/EPDP-348_JASEC-Test/EXPLORE_JEPYP-316_customer-form/evidence/${ENV.replace('jasec-', '')}`);

const SUBJECTS = [
  { key: 'K', charter: 'control', title: 'full address', address: undefined },
  { key: 'C', charter: '6.3', title: 'Cantón (and Distrito) blank', address: { city: '', district: '' } },
  // country stays CRI: AddressInput refuses country "" ("not a valid 'Country'"), and the form, with País cleared,
  // stores CRI too (ACT-101382, finding F2). So this is exactly what an all-blank form saves.
  { key: 'B', charter: '6.4', title: 'every address field blank (as the form saves it: CRI + blanks)', address: { street: '', city: '', state: '', postalCode: '', country: 'CRI', district: '' } },
] as const;

test('JEPYP-316: blank address fields still taxed at billing? (exploratory) @316-tax', async ({ request }) => {
  if (blockedIf(!RUN, 'JEPYP316_TAX_RUN is not "true" - this seeds, sends MDR readings, moves the CCP clock and bills')) return;
  if (blockedIf(!ALLOWED, `dev / preprod only (TEST_ENV=${ENV})`)) return;
  if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
  test.setTimeout(1_800_000);

  const seed = new PrepaidSeedHelper();
  const mdr = new MdrRemoteHelper();
  const db = new DbHelper();
  await db.connect();
  const startClock = await seed.ccpDate();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const report: Record<string, unknown> = { env: ENV, bdom: BDOM, startClock, kwh: KWH, subjects: [] as unknown[] };
  try {
    if (blockedIf(!(await mdr.isAvailable()), 'MDR loader tree unreachable or wired to another tenant')) return;

    // 1. Accounts, top-ups, readings. JEPYP316_TAX_REUSE='<K id>,<C id>,<B id>' resumes a run that stopped after
    // seeding: the same accounts, only the missing readings are sent (a fresh seed would collide on the bill date).
    const s = uniqueRunSuffix();
    const acc: Array<{ key: string; accountId: string; meter: string }> = [];
    const reuse = String(process.env.JEPYP316_TAX_REUSE ?? '').split(',').map(x => x.trim()).filter(Boolean);
    if (reuse.length) {
      if (blockedIf(reuse.length !== SUBJECTS.length, `JEPYP316_TAX_REUSE needs ${SUBJECTS.length} account ids (K,C,B)`)) return;
      for (const [i, sub] of SUBJECTS.entries()) {
        const m = (await db.query<{ meter: string; cid: string }>(
          `SELECT sp.provisioningid meter, a.customerid cid FROM core_engine.account a
             JOIN core_engine.service_unit su ON su.accountid = a.id
             JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
            WHERE a.id = $1`, [reuse[i]]))[0];
        if (blockedIf(!m || !m.cid.startsWith(`E2E316TAX-${sub.key}-`), `${reuse[i]} is not our E2E316TAX-${sub.key} account`)) return;
        acc.push({ key: sub.key, accountId: reuse[i], meter: m.meter });
        console.log(`  ${sub.key} ${sub.title}: ${reuse[i]} meter ${m.meter} (reused)`);
      }
    } else {
      for (const sub of SUBJECTS) {
        const meter = assertQaMeter(`M-QAADR${sub.key}-${s}`);   // the tag must be letters only (QA_METER_RE)
        const { accountId } = await seed.seed({
          meter, customerId: `E2E316TAX-${sub.key}-${s}`, name: `E2E316TAX ${sub.key} ${s}`, billingDom: BDOM,
          address: sub.address,
        });
        await seed.topUp(accountId, TOP_UP);
        acc.push({ key: sub.key, accountId, meter });
        console.log(`  ${sub.key} ${sub.title}: ${accountId} meter ${meter}`);
      }
    }
    const ids = acc.map(a => a.accountId);
    for (const id of ids) for (let i = 0; i < 20 && (await db.getTopUpCount(id)) === 0; i++) await wait(3_000);
    const stored = await db.query(
      `SELECT accountid, country, state, city, district, street, postalcode FROM core_engine.address WHERE accountid = ANY($1) ORDER BY accountid`, [ids]);
    console.log('  stored addresses:'); console.table(stored);

    const processed = async (m: string) => Number((await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND status = 'PROCESSED'`, [m]))[0]?.n ?? 0);
    // MDR file names carry a seconds timestamp: two uploads in the same second collide, so space them out.
    for (const a of acc) if ((await processed(a.meter)) < 1) { await mdr.submitReading(a.meter, BASELINE); await wait(2_000); }
    for (const a of acc) for (let i = 0; i < 30 && (await processed(a.meter)) < 1; i++) await wait(5_000);
    await wait(60_000); // the next reading must be stamped after the baseline
    for (const a of acc) if ((await processed(a.meter)) < 2) { await mdr.submitReading(a.meter, BASELINE + KWH); await wait(2_000); }
    for (const a of acc) for (let i = 0; i < 30 && (await processed(a.meter)) < 2; i++) await wait(5_000);
    const rated = await Promise.all(acc.map(async a => ({ key: a.key, n: await processed(a.meter) })));
    console.log(`  rated: ${rated.map(r => `${r.key}=${r.n}/2`).join(' ')}`);
    if (blockedIf(rated.some(r => r.n < 2), `usage did not rate on every account (${JSON.stringify(rated)})`)) return;

    // 2. One bill date for all three; nobody else due on it.
    let row: { nad: string; bill: string } | undefined;
    for (let i = 0; i < 20 && !row; i++) {
      row = (await db.query<{ nad: string; bill: string }>(
        `SELECT bp.nextaccountingdate::date::text nad, (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text bill
           FROM core_engine.billing_profile bp JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
          WHERE bp.accountid = $1`, [ids[0]]))[0];
      if (!row) await wait(3_000);
    }
    if (blockedIf(!row, `${ids[0]} has no PENDING bill unit`)) return;
    // JEPYP316_TAX_ALSO_BILL='ACT-x,...' lets named accounts be billed with ours - only our own leftovers
    // (customerId E2E* / QA*), e.g. an abandoned subject already parked on this bill date.
    const also = String(process.env.JEPYP316_TAX_ALSO_BILL ?? '').split(',').map(x => x.trim()).filter(Boolean);
    if (also.length) {
      const own = await db.query<{ id: string }>(`SELECT id FROM core_engine.account WHERE id = ANY($1) AND customerid ~* '^(E2E|QA)'`, [also]);
      if (blockedIf(own.length !== also.length, `JEPYP316_TAX_ALSO_BILL may name only our own E2E/QA accounts (${also.join(',')})`)) return;
    }
    const others = await db.query<{ n: number }>(
      `SELECT count(DISTINCT bp.accountid)::int n FROM core_engine.billing_profile bp
         JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
        WHERE bp.accountid <> ALL($1) AND bp.nextaccountingdate = $2::date - core_engine.get_future_cycle_date(bp.accountid)`, [[...ids, ...also], row!.bill]);
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
    report.schedule = { id: scheduleId, states, billDate: row!.bill };

    // 4. Per account: what was billed and taxed.
    const rate = IVA + ICB;
    const near = (a: number, b: number) => Math.abs(a - b) < Math.max(1, Math.abs(b) * 0.02);
    for (const a of acc) {
      const sub = SUBJECTS.find(x => x.key === a.key)!;
      const bu = (await db.query<{ id: string; status: string; total: string }>(
        `SELECT id, status, billtotal::text total FROM core_engine.bill_unit WHERE accountid = $1 AND enddate::date = $2::date`, [a.accountId, row!.nad]))[0];
      const lines = bu ? await db.query<{ description: string; type: string; net: number; taxcode: string }>(
        `SELECT description, type, netamount::float8 net, coalesce(taxcode,'') taxcode FROM core_engine.transaction_unit WHERE billunitid = $1 ORDER BY id`, [bu.id]) : [];
      const taxRows = bu ? await db.query<{ itemid: string; name: string; taxable: number; amount: number; rate: string }>(
        `SELECT coalesce(itemid,'') itemid, coalesce(name,'') name, coalesce(taxableamount,0)::float8 taxable,
                coalesce(amount,0)::float8 amount, coalesce(taxrate::text,'') rate
           FROM core_engine.invoice_tax_detail WHERE billunitid = $1 ORDER BY itemid, name`, [bu.id]) : [];
      const inv = bu ? await db.query<{ id: string; total: number; due: number; status: string }>(
        `SELECT id, total::float8 total, due::float8 due, status FROM core_engine.invoice_unit WHERE billunitid = $1`, [bu.id]) : [];
      const errs = await db.query<{ type: string; reason: string }>(
        `SELECT l.type, left(coalesce(e.reason,''),160) reason FROM core_engine.jobs_error e
           JOIN core_engine.job_schedule_list l ON l.jobid = e.id WHERE l.id = $1 AND e.accountid = $2`, [scheduleId, a.accountId]);
      const isTax = (l: { description: string; type: string }) => /tax/i.test(l.description) || /TAX/.test(l.type);
      const base = lines.filter(l => !isTax(l) && /^(ENERGIA|CVG ENERGIA|CVG ALUMBRADO PUBLICO)$/i.test(l.description)).reduce((x, l) => x + l.net, 0);
      const tax = taxRows.length ? taxRows.reduce((x, r) => x + r.amount, 0) : lines.filter(isTax).reduce((x, l) => x + l.net, 0);
      const expected = base * rate;
      const verdict = !bu || bu.status === 'PENDING' ? 'NOT BILLED'
        : near(tax, expected) ? 'TAXED (IVA + ICB as expected)'
        : Math.abs(tax) < 0.01 ? 'NOT TAXED - silent zero tax (defect)'
        : 'TAXED, but not base x rate - investigate';
      console.log(`\n  ${a.key} ${sub.title} ${a.accountId}: bill ${bu?.id ?? '-'} ${bu?.status ?? '-'}; invoice ${inv.map(i => `${i.id} ${i.total}`).join(',') || 'NONE'}`);
      for (const l of lines) console.log(`      ${l.description.padEnd(36)} ${l.net.toFixed(2).padStart(12)}  ${l.taxcode}`);
      console.log(`    energy base ${base.toFixed(2)}  tax ${tax.toFixed(2)}  expected ${expected.toFixed(2)}  -> ${verdict}`);
      if (errs.length) console.log(`    job errors: ${errs.map(e => `${e.type}: ${e.reason}`).join(' | ')}`);
      (report.subjects as unknown[]).push({ key: a.key, charter: sub.charter, title: sub.title, accountId: a.accountId, meter: a.meter,
        address: stored.find((r: any) => r.accountid === a.accountId), bill: bu, invoice: inv, lines, taxRows, base, tax, expected, verdict, errs });
    }

    // Harness only: every subject was billed. The tax verdicts are the finding.
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const file = path.join(EVIDENCE, `6.3-6.4-blank-address-tax-${s}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\n  report: ${file}`);
    for (const x of report.subjects as Array<{ key: string; bill?: { status: string } }>) {
      expect(x.bill, `${x.key}: no bill unit for the cycle - the run did not bill`).toBeTruthy();
      expect(x.bill!.status, `${x.key}: bill still PENDING - not billed`).not.toBe('PENDING');
    }
  } finally {
    await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
    await db.disconnect();
  }
});
