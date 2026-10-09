/**
 * EXPLORATORY - NOT an official case (no TC number, not in INDEX). Records the answer; asserts only the harness.
 *
 * Question (2026-10-09, from the notification-timing trace): when a prepaid MONTH-END BILL is refused for credit,
 *   (a) is the customer cut?  The engine skips the limit actions on a refused bill
 *       (PGCreditLimitEvaluationService.limitActionsLeftToUsageParkPath) and only the usage path suspends after a
 *       rollback, so the code says NO.
 *   (b) is the bill ever billed again?  BILL_CHECK picks an account only when
 *       nextaccountingdate = run date - delay (insert_jobs), and a refused bill rolls back without moving that date,
 *       so the code says NO - not the next day, not after a top-up, and not next month.
 * Seen on prod 2026-10-08: ts-11's refused accounts ACT-100182..188 still ACTIVE, bill PENDING. This proves it
 * prospectively, the operator's way: the Daily Schedule screen (Create Job Schedule > Process) on each date.
 *
 * Subjects (fresh, ours): A credit 0 (refused, nothing else), B credit 0 (refused, then a 5,000 top-up),
 * C control with 5,000 credit (enough for two months - it must be billed on both bill dates).
 * Dates: D = their bill date; D+1 (re-run); top-up B; D+2 (re-run after the top-up); N = C's next bill date (next month).
 *
 * MUTATING: seeds 3 accounts, moves the CCP clock (restored at the end), runs the DAILY chain on 4 dates - each date's
 * DAILY slot is used up for good. Own-data guard: BLOCKED if any account that is not ours is due on a date, or would be
 * picked by CREDIT_LIMIT_ACTIONS (balance over its limit). dev / preprod / prod test builds.
 * The spec owns the clock (test.use ccpBaseline: null): the jasec fixture's default would rewind the shared clock to
 * 2026-07-15 before the test - it did on preprod 2026-10-09 (first run, restored by hand to 10-08).
 *   $env:JASEC_REFUSED_BILL_RUN='true'; npx playwright test --project=jasec-billing-explore --grep "@refused-bill"
 *   optional: JASEC_REFUSED_BILL_BDOM (default 11)
 */
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';
import { AgentScreens } from '../../../../helpers/agent-screens.helper';

const RUN = String(process.env.JASEC_REFUSED_BILL_RUN ?? '').trim().toLowerCase() === 'true';
const ALLOWED = ['jasec-dev', 'jasec-preprod', 'jasec'].includes(process.env.TEST_ENV ?? '');
const BDOM = Number(process.env.JASEC_REFUSED_BILL_BDOM ?? 11);
const CONTROL_CREDIT = 5000;   // covers TWO months (2 x 1,943.40), so C is billed at D and again at N
const LATE_TOPUP = 5000;
/** "Ours" = an account our specs seeded: a QA meter or an E2E/QA customer id. Everything else is someone else's. */
const OURS_SQL = `(coalesce((SELECT string_agg(sp.provisioningid, ',') FROM core_engine.service_unit su
                     JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
                    WHERE su.accountid = a.id), '') LIKE 'M-QA%' OR a.customerid ~* '^(E2E|QA)')`;

// This spec owns the clock: never let the fixture rewind it to its 2026-07-15 default first.
test.use({ ccpBaseline: null });

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
};

type Snap = { id: string; sub: string; nad: string; pending: number; billed: number; invoices: number; suspends: number;
              bal: string; breach: number };

async function snapshot(db: DbHelper, ids: string[]): Promise<Snap[]> {
  return db.query<Snap>(
    `SELECT a.id,
            coalesce((SELECT status FROM core_engine.subscription s WHERE s.accountid = a.id ORDER BY createddate DESC LIMIT 1), '') AS sub,
            bp.nextaccountingdate::date::text AS nad,
            (SELECT count(*) FROM core_engine.bill_unit bu WHERE bu.accountid = a.id AND bu.status = 'PENDING')::int AS pending,
            (SELECT count(*) FROM core_engine.bill_unit bu WHERE bu.accountid = a.id AND bu.status <> 'PENDING')::int AS billed,
            (SELECT count(*) FROM core_engine.invoice_unit iu WHERE iu.accountid = a.id)::int AS invoices,
            (SELECT count(*) FROM core_oms."order" o WHERE o.accountid = a.id AND o.type = 'SUSPEND')::int AS suspends,
            coalesce((SELECT bb.amount::text FROM core_engine.balance_unit b JOIN core_engine.balance_unit_balances bb ON bb.id = b.id
                       WHERE b.accountid = a.id AND bb.currencyid = 'CRC'), '') AS bal,
            (SELECT count(*) FROM core_engine.email_notification e WHERE e.accountid = a.id AND e.type = 'CREDIT_LIMIT_BREACH')::int AS breach
       FROM core_engine.account a JOIN core_engine.billing_profile bp ON bp.accountid = a.id
      WHERE a.id = ANY($1) ORDER BY a.id`, [ids]);
}

function print(label: string, rows: Snap[], names: Record<string, string>) {
  console.log(`\n  [${label}]`);
  for (const r of rows) {
    console.log(`    ${names[r.id]} ${r.id}: subscription ${r.sub}, next accounting ${r.nad}, bills pending ${r.pending} / billed ${r.billed}, ` +
      `invoices ${r.invoices}, SUSPEND orders ${r.suspends}, balance ${r.bal}, Saldo Agotado rows ${r.breach}`);
  }
}

/** BLOCKED unless only our accounts are touched by a DAILY run on `date`. */
async function ownDataOnly(db: DbHelper, date: string): Promise<boolean> {
  const due = await db.query<{ id: string }>(
    `SELECT a.id FROM core_engine.billing_profile bp
       JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
       JOIN core_engine.account a ON a.id = bp.accountid
      WHERE bp.nextaccountingdate = $1::date - core_engine.get_future_cycle_date(bp.accountid) AND NOT ${OURS_SQL}`, [date]);
  const cut = await db.query<{ id: string }>(
    `SELECT DISTINCT a.id FROM core_engine."subscription" s
       JOIN core_engine.account a ON a.id = s.accountid
       JOIN core_config.credit_profile c ON c.name = s.creditprofilename
       JOIN core_config.credit_profiles cp ON cp.id = c.id AND cp.currency = a.currency
       JOIN core_engine.balance_unit_balances bub ON bub.id = s.balanceunitid
      WHERE bub.amount > cp.creditlimit AND NOT ${OURS_SQL}
        AND EXISTS (SELECT 1 FROM core_config.credit_profile_limit_actions l WHERE l.id = cp.id AND l.refindex = cp.index)`);
  const slot = await db.query<{ n: number }>(
    `SELECT count(*)::int n FROM core_engine.job_schedule WHERE scheduledate::date = $1::date AND schedulefrequency = 'DAILY'`, [date]);
  return !blockedIf(due.length > 0 || cut.length > 0 || slot[0].n > 0,
    `the DAILY run on ${date} would touch accounts that are not ours or cannot run: due ${due.map(x => x.id).join(', ') || 'none'}; ` +
    `over their limit (CREDIT_LIMIT_ACTIONS) ${cut.map(x => x.id).join(', ') || 'none'}; DAILY slot already used: ${slot[0].n > 0}`);
}

test('a refused month-end bill: is the customer cut, and is the bill ever billed again? (exploratory) @refused-bill',
  async ({ dailySchedulePage, page, testLogger }, testInfo) => {
    if (blockedIf(!RUN, 'JASEC_REFUSED_BILL_RUN is not "true" - this seeds accounts, moves the clock and runs DAILY on 4 dates')) return;
    if (blockedIf(!ALLOWED, `dev / preprod / prod test builds only (TEST_ENV=${process.env.TEST_ENV})`)) return;
    if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
    test.setTimeout(3_600_000);

    const seed = new PrepaidSeedHelper(testLogger);
    const db = new DbHelper(testLogger);
    await db.connect();
    const startClock = await seed.ccpDate();
    const names: Record<string, string> = {};
    const note = (title: string, body: string) => {
      console.log(`  OBSERVED - ${title}: ${body}`);
      testInfo.annotations.push({ type: 'observed', description: `${title}: ${body}` });
    };
    const runDaily = async (date: string) => {
      await seed.setCcpDate(date);
      const cards = await dailySchedulePage.createAndProcess(date, () => seed.setCcpDate(date).then(() => undefined), testLogger);
      console.log(`  DAILY ${date}: ${Object.entries(cards).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    };
    try {
      // 1. Subjects.
      const ids: string[] = [];
      for (const [label, credit] of [['A', 0], ['B', 0], ['C', CONTROL_CREDIT]] as const) {
        const s = uniqueRunSuffix();
        const { accountId } = await seed.seed({ meter: assertQaMeter(`M-QARFB-${s}`), customerId: `E2ERFB${label}-${s}`,
          name: `E2ERFB ${label} ${s}`, billingDom: BDOM });
        ids.push(accountId); names[accountId] = label;
        if (credit) await seed.topUp(accountId, credit);
      }
      const [A, B, C] = ids;

      // 2. Their bill date (all three on one date once each has a PENDING bill unit).
      let dates: string[] = [];
      for (let i = 0; i < 20 && dates.length !== 1; i++) {
        const r = await db.query<{ d: string; n: number }>(
          `SELECT (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text d, count(*)::int n
             FROM core_engine.billing_profile bp JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
            WHERE bp.accountid = ANY($1) GROUP BY 1`, [ids]);
        if (r.length === 1 && r[0].n === 3) dates = [r[0].d]; else await new Promise(res => setTimeout(res, 3_000));
      }
      if (blockedIf(dates.length !== 1, 'the three accounts are not on one bill date')) return;
      const D = dates[0];
      console.log(`\n  A ${A}, B ${B}, C ${C} (control, credit ${CONTROL_CREDIT}); bill date ${D}; clock ${startClock}`);
      print('seeded', await snapshot(db, ids), names);

      // 3. Bill date: A and B must be refused, C billed (harness).
      if (!(await ownDataOnly(db, D))) return;
      await runDaily(D);
      const s1 = await snapshot(db, ids);
      print(`after DAILY ${D} (bill date)`, s1, names);
      const by = (rows: Snap[], id: string) => rows.find(r => r.id === id)!;
      expect(by(s1, C).billed, `control C ${C} was not billed on ${D} - the run did not bill at all`).toBeGreaterThan(0);
      if (blockedIf(by(s1, A).billed > 0 || by(s1, B).billed > 0, `A or B was billed on ${D} - no refusal to follow up`)) return;
      expect.soft(by(s1, A).breach, `A ${A} got no Saldo Agotado row for its refused bill`).toBeGreaterThan(0);
      note('(a) cut after a refused bill', `A ${A}: subscription ${by(s1, A).sub}, SUSPEND orders ${by(s1, A).suspends}; ` +
        `B ${B}: subscription ${by(s1, B).sub}, SUSPEND orders ${by(s1, B).suspends}`);

      // 4. Next day: re-run.
      if (!(await ownDataOnly(db, addDays(D, 1)))) return;
      await runDaily(addDays(D, 1));
      const s2 = await snapshot(db, ids);
      print(`after DAILY ${addDays(D, 1)} (next day)`, s2, names);
      note('(b) re-billed the next day', `A billed ${by(s2, A).billed}, next accounting ${by(s2, A).nad}; B billed ${by(s2, B).billed}`);

      // 5. B tops up enough, then the next day's run.
      await seed.topUp(B, LATE_TOPUP);
      await new Promise(res => setTimeout(res, 20_000));
      print(`right after B's ${LATE_TOPUP} top-up`, await snapshot(db, [B]), names);
      if (!(await ownDataOnly(db, addDays(D, 2)))) return;
      await runDaily(addDays(D, 2));
      const s3 = await snapshot(db, ids);
      print(`after DAILY ${addDays(D, 2)} (after B's top-up)`, s3, names);
      note('(c) re-billed after a top-up', `B billed ${by(s3, B).billed}, invoices ${by(s3, B).invoices}, balance ${by(s3, B).bal}, ` +
        `next accounting ${by(s3, B).nad}`);

      // 6. Next month: C's next bill date.
      const N = (await db.query<{ d: string }>(
        `SELECT (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text d
           FROM core_engine.billing_profile bp WHERE bp.accountid = $1`, [C]))[0].d;
      if (!(await ownDataOnly(db, N))) return;
      await runDaily(N);
      const s4 = await snapshot(db, ids);
      print(`after DAILY ${N} (next month)`, s4, names);
      expect(by(s4, C).billed, `control C ${C} was not billed for its second cycle on ${N}`).toBeGreaterThan(by(s1, C).billed);
      note('(d) next month', `A billed ${by(s4, A).billed}, pending ${by(s4, A).pending}, next accounting ${by(s4, A).nad}; ` +
        `B billed ${by(s4, B).billed}, pending ${by(s4, B).pending}, next accounting ${by(s4, B).nad}; control C billed ${by(s4, C).billed}`);

      // 7. What an agent sees for A.
      const sv = await new AgentScreens(page).services(A);
      note('Core UI Services for A', `subscription ${sv.sub} (${sv.reason}); in-complete orders ${sv.incomplete.join(' | ') || 'none'}`);
    } finally {
      await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
      console.log(`  clock restored to ${startClock}`);
      await db.disconnect();
    }
  });
