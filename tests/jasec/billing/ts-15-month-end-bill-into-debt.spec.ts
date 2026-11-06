/**
 * TC-153 - Billing/ A month-end bill the balance cannot cover is billed into debt and the customer is cut.
 *
 * Replaces the refused-bill behaviour of defect F8 (explore-08): before the fix such a bill was REFUSED, the account's
 * nextaccountingdate froze and it was never billed again. The team's fix (deployed dev / preprod / prod, 2026-10-15):
 *   1. the bill is billed: the balance goes into debt (1,943.40 for a month under 30 kWh) and an invoice is made;
 *   2. the customer gets "Saldo Agotado" (CREDIT_LIMIT_BREACH) and "Inicio de Mes" saldo negativo (PREPAID_OVERAGE), and a
 *      SUSPEND (user CreditLimitBreach, reason CREDIT_LIMIT_EXCEEDED) is raised right after the bill - Mon-Fri 08:00-20:00
 *      Costa Rica time, not on holidays (outside those hours it waits); an account already cut gets no second mail or
 *      SUSPEND, also after a partial top-up;
 *   3. a top-up pays the debt first: B with 5,000 is reconnected with 3,056.60 of credit; a smaller top-up keeps it cut;
 *   4. next month the accounts are billed normally; a cut account is billed without the monthly fixed charge and its
 *      debt stays until a top-up pays it.
 * The Costa Rica clock cannot be simulated (the CCP clock has no time of day), so the case runs only in CR daytime on a
 * weekday and is BLOCKED otherwise - like TC-129's outside half.
 *
 * Subjects (fresh, ours): A credit 0, B credit 0, C control with 5,000 (covers two months). The SUSPEND/RESUME go to the
 * AMI, which refuses our invented M-QA meters, so JASEC's accepted callback is posted by the test (as in A5).
 * MUTATING: seeds 3 accounts, moves the CCP clock, runs the DAILY chain on 2 dates (each slot used for good).
 * Other accounts: billing or cutting them on dev / preprod is fine (Anh 2026-10-20) - they are only logged. The one
 * block is a real device: DailySchedulePage.clickProcess BLOCKS when the run could cut a meter JASEC's AMI has
 * accepted (provisioning-safety.helper blockIfAcceptedMeterAtRisk). A date whose slot is already used still BLOCKS.
 *   (optional: $env:JASEC_REFUSED_BILL_BDOM='<day>' - default: picked so the bill date is free)
 *   npx playwright test --project=jasec-billing-refused --grep "@month-end-debt"
 */
import { test, expect } from '../../../fixtures/jasec-fixtures';
import type { APIRequestContext } from '@playwright/test';
import { PrepaidSeedHelper } from '../../../helpers/prepaid-seed.helper';
import { DbHelper, hasDbConfig } from '../../../helpers/db.helper';
import { uniqueRunSuffix, assertQaMeter } from '../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../helpers/blocked.helper';
import { seedOnFreeBillDate } from '../../../helpers/free-billing-day.helper';
import { ensureDateFree } from '../../../helpers/schedule-slot.helper';
import { AgentScreens } from '../../../helpers/agent-screens.helper';
import { poll } from '../../../helpers/poll.helper';
import { ON_JASEC_PROD, PROD_REFUSAL } from '../../../helpers/prod-guard';

const TENANT = (process.env.TEST_ENV ?? '').trim();
const ALLOWED = ['jasec-dev', 'jasec-preprod'].includes(TENANT);
// Billing day: JASEC_REFUSED_BILL_BDOM if set, else picked so the first bill date has no job schedule yet (2026-10-19,
// was a fixed 11). Both DAILY dates are checked: foreign accounts due or over their limit are LOGGED (this run's
// CREDIT_LIMIT_ACTIONS really cuts in Costa Rica daytime); only a used slot or a real-device meter blocks.
const BDOM_SET = Number(process.env.JASEC_REFUSED_BILL_BDOM ?? 0);
const MONTH_MIN = 1943.40;            // the 0-30 kWh month (true-up minimum)
const CONTROL_CREDIT = 5000;          // C: two months
const B_TOPUP = 5000;                 // pays B's debt, leaves 3,056.60
const A_PARTIAL = 500;                // smaller than A's debt: A stays cut
const CALLBACK_URL = process.env.JASEC_PROVISION_CALLBACK_URL
  ?? `https://provision-gateway.${TENANT}.embrix.org/updateProvisioningRequest`;
/** "Ours" = an account our specs seeded: a QA meter or an E2E/QA customer id. */
const OURS_SQL = `(coalesce((SELECT string_agg(sp.provisioningid, ',') FROM core_engine.service_unit su
                     JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
                    WHERE su.accountid = a.id), '') LIKE 'M-QA%' OR a.customerid ~* '^(E2E|QA)')`;

test.use({ ccpBaseline: null });   // this case owns the clock

type Subject = { label: string; accountId: string; sub: string; svc: string; provId: string };
const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const money = (s: string | number) => Math.round(Number(s) * 100) / 100;

/** Costa Rica weekday 08:00-20:00, not a fixed-date holiday: '' when a cut must happen now, else why not. */
function crDaytimeReason(): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Costa_Rica', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (k: string) => p.find(x => x.type === k)?.value ?? '';
  const hh = Number(g('hour') === '24' ? '0' : g('hour')), mmdd = `${g('month')}-${g('day')}`;
  const holidays = ['01-01', '04-11', '05-01', '07-25', '08-02', '08-15', '09-15', '12-01', '12-25'];
  if (hh < 8 || hh >= 20) return `Costa Rica time is ${g('hour')}:${g('minute')} - outside 08:00-20:00`;
  if (['Sat', 'Sun'].includes(g('weekday'))) return `Costa Rica day is ${g('weekday')}`;
  if (holidays.includes(mmdd)) return `Costa Rica ${mmdd} is a public holiday`;
  return '';
}


async function state(db: DbHelper, s: Subject) {
  const r = await db.query<{ sub: string; nad: string; invoices: number; bal: string; lastbill: string }>(
    `SELECT (SELECT status FROM core_engine.subscription WHERE id = $2) AS sub,
            (SELECT nextaccountingdate::date::text FROM core_engine.billing_profile WHERE accountid = $1) AS nad,
            (SELECT count(*) FROM core_engine.invoice_unit WHERE accountid = $1)::int AS invoices,
            coalesce((SELECT bb.amount::text FROM core_engine.balance_unit b JOIN core_engine.balance_unit_balances bb ON bb.id = b.id
                       WHERE b.accountid = $1 AND bb.currencyid = 'CRC'), '') AS bal,
            coalesce((SELECT coalesce(billtotal,0)::text FROM core_engine.bill_unit WHERE accountid = $1 AND status <> 'PENDING'
                       ORDER BY enddate DESC LIMIT 1), '') AS lastbill`, [s.accountId, s.sub]);
  return r[0];
}
const mails = async (db: DbHelper, acct: string, type: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*)::text n FROM core_engine.email_notification WHERE accountid = $1 AND type = $2`, [acct, type]))[0].n);
const autoOrders = (db: DbHelper, acct: string, type: 'SUSPEND' | 'RESUME') => db.query<{ id: string; status: string; userid: string; reason: string }>(
  `SELECT id, status, userid, coalesce(subscriptionreason::text,'') reason FROM core_oms."order" WHERE accountid = $1 AND type = $2 ORDER BY id`, [acct, type]);

/** Foreign accounts Anh approved for one run (comma list) - e.g. preprod 43-79920, overdue since 10-16, billed by ANY DAILY. */
const ALLOW = (process.env.JASEC_REFUSED_BILL_ALLOW ?? '').split(',').map(x => x.trim()).filter(Boolean);

/**
 * BLOCKED only when the slot of `date` is used and cannot be reclaimed. Foreign accounts the run will bill or cut are
 * logged, not blocked (Anh 2026-10-20: affecting other dev / preprod accounts is fine; the real-device check runs at
 * Process).
 */
async function ownDataOnly(db: DbHelper, date: string): Promise<boolean> {
  const notAllowed = (rows: { id: string }[]) => rows.filter(r => !ALLOW.includes(r.id));
  if (ALLOW.length) console.log(`  own-data guard: Anh approved touching ${ALLOW.join(', ')} for this run`);
  const due = await db.query<{ id: string }>(
    `SELECT DISTINCT a.id FROM core_engine.billing_profile bp
       JOIN core_engine.bill_unit bu ON bu.accountid = bp.accountid AND bu.status = 'PENDING'
       JOIN core_engine.account a ON a.id = bp.accountid
      WHERE bp.nextaccountingdate <= $1::date - core_engine.get_future_cycle_date(bp.accountid) AND a.status = 'ACTIVE'
        AND NOT ${OURS_SQL}`, [date]);
  const cut = await db.query<{ id: string }>(
    `SELECT DISTINCT a.id FROM core_engine."subscription" s JOIN core_engine.account a ON a.id = s.accountid
       JOIN core_config.credit_profile c ON c.name = s.creditprofilename
       JOIN core_config.credit_profiles cp ON cp.id = c.id AND cp.currency = a.currency
       JOIN core_engine.balance_unit_balances bub ON bub.id = s.balanceunitid
      WHERE bub.amount > cp.creditlimit AND s.status = 'ACTIVE' AND NOT ${OURS_SQL}
        AND EXISTS (SELECT 1 FROM core_config.credit_profile_limit_actions l WHERE l.id = cp.id AND l.refindex = cp.index)`);
  const [dueX, cutX] = [notAllowed(due), notAllowed(cut)];
  const foreign = `due or overdue: ${dueX.map(x => x.id).slice(0, 10).join(', ') || 'none'}; ` +
    `over their limit: ${cutX.map(x => x.id).slice(0, 10).join(', ') || 'none'}`;
  if (dueX.length || cutX.length) console.log(`  DAILY ${date} will also touch accounts that are not ours (allowed) - ${foreign}`);
  // A used date is reclaimed on dev / preprod (schedule-slot.helper); blocks only when that is not possible.
  const slot = await ensureDateFree(db, date);
  return !blockedIf(!slot.free, `the DAILY on ${date} cannot run - ${slot.reason}. Pick another JASEC_REFUSED_BILL_BDOM`);
}

/** The AMI refuses our invented meter; post JASEC's accepted callback so the order completes. */
async function completeOrder(db: DbHelper, request: APIRequestContext, s: Subject, order: string, type: 'SUSPEND' | 'RESUME') {
  await poll(() => db.query<{ status: string }>(`SELECT status FROM core_oms."order" WHERE id = $1`, [order]),
    r => ['PROVISIONING_ERROR', 'PROVISIONING_INITIATED', 'COMPLETED'].includes(r[0]?.status ?? ''), 240_000);
  const accepted = await db.query<{ n: string }>(
    `SELECT count(*)::text n FROM core_engine.activity WHERE apiname ILIKE '%UTILITIES%' AND request::text LIKE $1 AND response::text ILIKE '%Registrada%'`,
    [`%<numeroOrden>${order}</numeroOrden>%`]);
  expect(Number(accepted[0].n), `JASEC ACCEPTED an invented meter for ${order} - stop and tell the team`).toBe(0);
  const res = await request.post(CALLBACK_URL, { headers: { 'Content-Type': 'application/json' }, timeout: 120_000,
    data: { accountId: s.accountId, orderType: type, orderId: order, status: 'COMPLETED',
            services: [{ serviceType: 'ELECTRICITY', action: type, bundleId: 'B-100000-E', provisioningDataType: 'METER', provisioningId: s.provId }] } });
  const body = await res.text();
  console.log(`  callback ${type} ${order} (${s.label}): HTTP ${res.status()} ${body.slice(0, 120)}`);
  expect(body, `${type} callback for ${order} was refused`).toContain('FINALIZADO');
}

test('a month-end bill the balance cannot cover is billed into debt, the customer is cut, and a top-up reconnects @tc-153 @month-end-debt',
  async ({ dailySchedulePage, page, request, testLogger }) => {
    if (blockedIf(ON_JASEC_PROD, PROD_REFUSAL)) return;
    if (blockedIf(!ALLOWED, `JASEC dev / preprod only (TEST_ENV=${TENANT})`)) return;
    if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
    const notNow = crDaytimeReason();
    if (blockedIf(!!notNow, `the cut happens right after the bill only in Costa Rica weekday daytime (08:00-20:00): ${notNow}`)) return;
    test.setTimeout(3_600_000);

    const seed = new PrepaidSeedHelper(testLogger);
    const db = new DbHelper(testLogger);
    await db.connect();
    const startClock = await seed.ccpDate();
    const runDaily = async (date: string) => {
      await seed.setCcpDate(date);
      const cards = await dailySchedulePage.createAndProcess(date, () => seed.setCcpDate(date).then(() => undefined), testLogger);
      console.log(`  DAILY ${date}: ${Object.entries(cards).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      return cards;
    };
    try {
      // 1. Subjects on one bill date. A fixes the billing day (JASEC_REFUSED_BILL_BDOM, or seeded until its bill date is
      //    free - 2026-10-19); B and C follow on the same day and clock, so all three share the bill date.
      const seedAs = (label: string) => async (day: number) => {
        const sfx = uniqueRunSuffix();
        return (await seed.seed({ meter: assertQaMeter(`M-QARFD-${sfx}`), customerId: `E2ERFD${label}-${sfx}`,
          name: `E2ERFD ${label} ${sfx}`, billingDom: day })).accountId;
      };
      let BDOM = BDOM_SET;
      let firstA = '';
      if (BDOM) firstA = await seedAs('A')(BDOM);
      else {
        const got = await seedOnFreeBillDate(db, { read: () => seed.ccpDate(), set: d => seed.setCcpDate(d) }, seedAs('A'));
        if (blockedIf(!got, 'no usable bill date: the date is taken and cannot be reclaimed here (a PROCESSING run, a non-test tenant or JASEC_RECLAIM_SLOTS=false) - see the log')) return;
        firstA = got!.accountId; BDOM = got!.day;
      }
      const subj: Subject[] = [];
      for (const [label, credit] of [['A', 0], ['B', 0], ['C', CONTROL_CREDIT]] as const) {
        const accountId = label === 'A' ? firstA : await seedAs(label)(BDOM);
        if (credit) await seed.topUp(accountId, credit);
        const r = await poll(() => db.query<{ svc: string; sub: string; provid: string }>(
          `SELECT su.id svc, su.subscriptionid sub, su.provisioningid provid FROM core_engine.service_unit su
             JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER' WHERE su.accountid = $1 AND su.status = 'ACTIVE'`, [accountId]),
          x => x.length === 1, 120_000, 5_000);
        expect(r.length, `${accountId} has no ACTIVE metered service unit`).toBe(1);
        subj.push({ label, accountId, sub: r[0].sub, svc: r[0].svc, provId: r[0].provid });
      }
      const [A, B, C] = subj;
      const dates = await poll(() => db.query<{ d: string }>(
        `SELECT DISTINCT (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text d
           FROM core_engine.billing_profile bp JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid AND bu.status = 'PENDING'
          WHERE bp.accountid = ANY($1)`, [subj.map(x => x.accountId)]), x => x.length === 1, 60_000, 3_000);
      if (blockedIf(dates.length !== 1, 'the three accounts are not on one bill date')) return;
      const D = dates[0].d;
      console.log(`\n  A ${A.accountId}, B ${B.accountId}, C ${C.accountId} (credit ${CONTROL_CREDIT}); bill date ${D}; clock ${startClock}`);

      // 2. Bill date: everyone billed; A and B into debt, mailed and cut right after the bill.
      if (!(await ownDataOnly(db, D))) return;
      const cards = await runDaily(D);
      expect.soft(Object.values(cards).filter(v => /ERROR|FAIL/i.test(v)), `DAILY ${D}: no job may end in error`).toEqual([]);
      for (const s of [A, B]) {
        const st = await state(db, s);
        console.log(`  ${s.label} after the bill: ${JSON.stringify(st)}`);
        expect(st.invoices, `${s.label} ${s.accountId} must be billed and invoiced on ${D}`).toBeGreaterThan(0);
        expect(money(st.bal), `${s.label}: the balance must show the month as debt`).toBeCloseTo(MONTH_MIN, 2);
        expect(st.nad > addDays(D, -1), `${s.label}: the next accounting date must move past ${D} (was frozen before the fix)`).toBe(true);
        expect(await mails(db, s.accountId, 'CREDIT_LIMIT_BREACH'), `${s.label}: Saldo Agotado`).toBe(1);
        expect(await mails(db, s.accountId, 'PREPAID_OVERAGE'), `${s.label}: Inicio de Mes (saldo negativo)`).toBe(1);
        const sus = await poll(() => autoOrders(db, s.accountId, 'SUSPEND'), x => x.length > 0, 240_000);
        expect(sus.length, `${s.label}: one SUSPEND right after the bill`).toBe(1);
        expect(sus[0].userid, `${s.label}: SUSPEND user`).toBe('CreditLimitBreach');
        expect(sus[0].reason, `${s.label}: SUSPEND reason`).toBe('CREDIT_LIMIT_EXCEEDED');
        await completeOrder(db, request, s, sus[0].id, 'SUSPEND');
        const cut = await poll(() => state(db, s), x => x.sub === 'SUSPENDED', 120_000, 5_000);
        expect(cut.sub, `${s.label}: subscription after the SUSPEND callback`).toBe('SUSPENDED');
      }
      const c1 = await state(db, C);
      expect(c1.invoices, 'control C must be billed on the bill date').toBeGreaterThan(0);
      expect(money(c1.bal), 'control C: 5,000 credit minus the month').toBeCloseTo(-(CONTROL_CREDIT - MONTH_MIN), 2);
      expect((await autoOrders(db, C.accountId, 'SUSPEND')).length, 'control C must not be cut').toBe(0);

      // 3. A tops up LESS than its debt: debt shrinks, A stays cut, no second mail or SUSPEND.
      await seed.topUp(A.accountId, A_PARTIAL);
      const a2 = await poll(() => state(db, A), x => money(x.bal) < MONTH_MIN, 120_000, 5_000);
      expect(money(a2.bal), 'A: the partial top-up pays part of the debt').toBeCloseTo(MONTH_MIN - A_PARTIAL, 2);
      await new Promise(r => setTimeout(r, 30_000));
      expect((await state(db, A)).sub, 'A: a top-up smaller than the debt keeps the account cut').toBe('SUSPENDED');
      expect((await autoOrders(db, A.accountId, 'RESUME')).length, 'A: no RESUME while debt remains').toBe(0);
      expect((await autoOrders(db, A.accountId, 'SUSPEND')).length, 'A: no second SUSPEND').toBe(1);
      expect(await mails(db, A.accountId, 'CREDIT_LIMIT_BREACH'), 'A: no second Saldo Agotado').toBe(1);

      // 4. B tops up enough: the debt is paid first, B is reconnected with the rest as credit.
      await seed.topUp(B.accountId, B_TOPUP);
      const res = await poll(() => autoOrders(db, B.accountId, 'RESUME'), x => x.length > 0, 240_000);
      expect(res.length, 'B: paying the debt raises a RESUME').toBe(1);
      await completeOrder(db, request, B, res[0].id, 'RESUME');
      const b4 = await poll(() => state(db, B), x => x.sub === 'ACTIVE', 120_000, 5_000);
      expect(b4.sub, 'B: reconnected').toBe('ACTIVE');
      expect(money(b4.bal), 'B: 5,000 minus the 1,943.40 debt left as credit').toBeCloseTo(-(B_TOPUP - MONTH_MIN), 2);

      // 5. Next month (C's next bill date): billed normally; cut A billed without the monthly fixed charge, debt stays.
      const N = (await db.query<{ d: string }>(
        `SELECT (bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text d FROM core_engine.billing_profile bp WHERE bp.accountid = $1`,
        [C.accountId]))[0].d;
      if (!(await ownDataOnly(db, N))) return;
      const before = { A: await state(db, A), B: await state(db, B), C: await state(db, C) };
      await runDaily(N);
      const after = { A: await state(db, A), B: await state(db, B), C: await state(db, C) };
      console.log(`  next month ${N}: ${JSON.stringify(after)}`);
      expect(after.B.invoices, 'B: billed next month').toBe(before.B.invoices + 1);
      expect(money(after.B.bal), 'B: the month comes off its credit').toBeCloseTo(money(before.B.bal) + MONTH_MIN, 2);
      expect(after.C.invoices, 'C: billed next month').toBe(before.C.invoices + 1);
      expect(money(after.A.lastbill), 'A (cut): billed without the monthly fixed charge').toBeCloseTo(0, 2);
      expect(money(after.A.bal), 'A (cut): its debt stays until a top-up pays it').toBeCloseTo(money(before.A.bal), 2);

      // 6. What an agent sees.
      const sv = await new AgentScreens(page).services(A.accountId);
      console.log(`  Core UI Services A: subscription ${sv.sub} (${sv.reason}); in-complete ${sv.incomplete.join(' | ') || 'none'}`);
      expect.soft(sv.sub, 'Core UI Services: A shows SUSPENDED').toBe('SUSPENDED');
    } finally {
      await db.disconnect();
    }
  });
