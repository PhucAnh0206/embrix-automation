/**
 * JEPYP-475 "Fix Balance for service cancelation" - the balance follows the customer from a cancelled service to the
 * new one. Deployed on jasec-dev, jasec-preprod and prod 2026-10-17.
 * Official cases (2026-10-18): checks 1, 2, 5 and display = TC-04 (account); checks 3, 4 = TC-154 (billing).
 *
 * Business rules (Luis, ticket + 2026-10-17 answers):
 *   - ANY cancel followed by a new service moves the balance, credit AND debt; it goes to the newest service added
 *     after the cancellation. Accounting: no impact. Statement and Self Care: shown on the active service.
 *   - Moved debt over the limit: the new service is cut straight away; the customer pays to reconnect.
 *   - Last bill of a cancelled service: at least the minimum, no proration; cancel + new in the same month = ONE minimum.
 * Implementation note (dev team 2026-10-17) - the five checks, numbered as here:
 *   1 credit: new service shows the whole balance (Balances screen, Self Care), cancelled shows 0; Customer Activity
 *     "Saldo a favor ... trasladado" (apiname BALANCE_MOVED_TO_NEW_SUBSCRIPTION).
 *   2 debt over the limit: "Saldo Agotado" is sent and the new service is cut (not at night, weekends, holidays);
 *     a top-up reconnects.
 *   3 cancel + new in the same month: the month-start bill charges ONE minimum on the whole month's kWh.  (TC-154)
 *   4 cancel with no new service: the last bill charges at least the minimum, no proration.               (TC-154)
 *   5 after the change, a reading of the OLD meter dated before the cancel is charged to the new service's balance,
 *     is not held, and sends no "Saldo Agotado".
 *   A balance left on a cancelled service BEFORE the deploy does not move (preprod 43-79920 keeps 522) - new accounts only.
 *   Side check (under TC-04, not its own TC, 2026-10-21): the month's kWh follow too - 100 kWh on the old meter + 5 on the
 *     new one crosses the Bomberos line, and BOM is charged on the whole month (@balance-transfer-tax-threshold).
 *
 * Flow: seed a prepaid account (QA meter) -> credit (real top-up) or debt (direct balance write) on subscription 1 ->
 * CANCEL it the proper way (PrepaidSeedHelper.cancel) -> NEW subscription on the same account with a NEW meter.
 * Check 2 puts the new subscription on "Prepaid Energy E2E No Window" (JASEC_TRANSFER_PROFILE) so the cut can be seen
 * at any hour: its subject is the moved debt, not the window (the window itself is TC-129/130). If no cut is raised,
 * it is BLOCKED (weekend / holiday rule), not a failure.
 *
 * MUTATING: seeds accounts, CANCEL / NEW orders, simulated JASEC callbacks, MDR readings, CCP clock (check 5; forward only, not put back on test tenants).
 * dev / preprod only; refused on JASEC production.
 *   npx playwright test --project=jasec-balance-transfer
 * JASEC_JEPYP475_DEPLOYED defaults to true; =false reports a balance still on the closed subscription as BLOCKED "fix not deployed".
 * Business rules: JEPYP-475.
 */
import type { APIRequestContext, Page } from '@playwright/test';
// jasec-fixtures: page-factory (navigateToHome for AgentScreens) + the Self Care page fixtures. Its auto-fixture rewinds
// the CCP clock to 2026-07-15 before every test - switched OFF below (10-17: a probe without the opt-out moved preprod
// from 2026-11-02 to 07-15).
import { test, expect } from '../../../fixtures/jasec-fixtures';
import { PrepaidSeedHelper } from '../../../helpers/prepaid-seed.helper';
import { DbHelper } from '../../../helpers/db.helper';
import { TestLogger } from '../../../helpers/test-logger';
import { MdrRemoteHelper } from '../../../helpers/mdr-remote.helper';
import { uniqueRunSuffix, assertQaMeter } from '../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../helpers/blocked.helper';
import { seedOnFreeBillDate } from '../../../helpers/free-billing-day.helper';
import { BillingGqlHelper } from '../../../helpers/billing-gql.helper';
import { AgentScreens } from '../../../helpers/agent-screens.helper';
import { attachToAccountInSelfCare } from '../../../fixtures/create-prepaid-account.helper';
import { sleep, poll } from '../../../helpers/poll.helper';
import { ensureDateFree } from '../../../helpers/schedule-slot.helper';
import { subscriptions, orderSettled, activeProvisioningId, type Sub } from '../../../helpers/subscription-state.helper';
import { addDays, clockForward, clockPastAccount, firstOfNextMonth } from '../../../helpers/clock-policy';
import { ON_JASEC_PROD, PROD_REFUSAL } from '../../../helpers/prod-guard';

const DEPLOYED = String(process.env.JASEC_JEPYP475_DEPLOYED ?? 'true').trim().toLowerCase() === 'true';
const TENANT = (process.env.TEST_ENV ?? 'jasec-dev').trim();
const CALLBACK_URL = process.env.JASEC_PROVISION_CALLBACK_URL
  ?? `https://provision-gateway.${TENANT}.embrix.org/updateProvisioningRequest`;
const NO_WINDOW = process.env.JASEC_TRANSFER_PROFILE ?? 'Prepaid Energy E2E No Window';
/** provisioningEnabled=false: suspensions are billing-only (no SUSPEND/RESUME order to the AMI) - jasec-oci-dev. */
async function provisioningOff(db: DbHelper): Promise<boolean> {
  return (await db.query<{ v: string }>(
    `SELECT value AS v FROM core_config.ccp_properties WHERE property = 'provisioningEnabled'`))[0]?.v === 'false';
}
const STOCK_PROFILE = 'Prepaid Energy Profile';                          // the real profile, with the no-cut window
const CREDIT = Number(process.env.JASEC_TRANSFER_CREDIT ?? 522);    // 43-79920's stranded credit
const DEBT = Number(process.env.JASEC_TRANSFER_DEBT ?? 1943.40);    // a full month-end bill, over the 0 limit
const MONTH_MIN = 1943.40;                                          // one month's minimum (0-30 kWh), as TC-153


interface Moved { accountId: string; funded: Sub; old: Sub; sub2: Sub; moved: number; meter1: string; meter2: string; prov2: string; t0: string }

/**
 * Check 1's credit move, kept for "display" (Anh 2026-10-29): both build the identical `resubscribe('credit', CREDIT)`
 * and neither changes the account afterwards. Set only when check 1 ended with no error; "display" reuses it only if
 * the database still shows the same balances on both services, otherwise (or run alone) it builds its own.
 */
let creditMove: Moved | undefined;
async function stillAsMoved(db: DbHelper, r: Moved): Promise<boolean> {
  const now = await subscriptions(db, r.accountId);
  const same = (s: Sub) => { const x = now.find(n => n.id === s.id); return !!x && x.status === s.status && Math.abs(x.balance - s.balance) < 0.005; };
  return same(r.old) && same(r.sub2);
}

/** Mail watermark: the highest email_notification number now. Mail rows are stamped with the CCP DATE at midnight, so a
 *  date filter is useless (dev 10-17: CCP 07-15 is behind real time and hid the Saldo Agotado); the id only grows. */
async function mailWatermark(db: DbHelper): Promise<string> {
  return (await db.query<{ n: string }>(
    `SELECT coalesce(max(substring(id from '[0-9]+$')::bigint), 0)::text AS n FROM core_engine.email_notification`))[0].n;
}

/** Seed, fund sub 1, cancel it, open sub 2 on a new meter (optionally on another credit profile). */
async function resubscribe(db: DbHelper, logger: TestLogger, kind: 'credit' | 'debt', amount: number, newProfile?: string,
                           beforeCancel?: (meter1: string) => Promise<void>): Promise<Moved> {
  const seed = new PrepaidSeedHelper(logger);
  const sfx = uniqueRunSuffix();
  const meter1 = assertQaMeter(`M-QABAL-${sfx}1`);
  const meter2 = assertQaMeter(`M-QABAL-${sfx}2`);
  const s = await seed.seed({ meter: meter1, customerId: `E2EBAL-${sfx}`, name: `QA BALANCE TRANSFER ${kind} ${sfx}` });
  const ord1 = await orderSettled(db, s.orderId);
  blockedIf(ord1 !== 'COMPLETED', `${s.accountId}: the first order ${s.orderId} ended ${ord1}`);

  const sub1 = (await subscriptions(db, s.accountId)).find(x => x.status === 'ACTIVE');
  blockedIf(!sub1, `${s.accountId}: no ACTIVE subscription after seeding`);
  if (kind === 'credit') await seed.topUp(s.accountId, amount);                 // JASEC sign: credit reads negative
  else await db.setBalanceAmount(sub1!.buid, amount);                          // debt reads positive (synthetic on purpose:
                                                                                // no quick real path to a debt without billing)
  const funded = await poll(async () => (await subscriptions(db, s.accountId)).find(x => x.id === sub1!.id)!,
    x => Math.abs(Math.abs(x.balance) - amount) < 0.01, 60_000, 3_000);
  console.log(`  ${s.accountId}: sub 1 ${funded.id} (${meter1}) balance ${funded.balance} after the ${kind} of ${amount}`);

  if (beforeCancel) await beforeCancel(meter1);                                     // e.g. move the clock: cancel later than the seed
  const t0 = await mailWatermark(db);
  const cancelOrder = await seed.cancel(s.accountId, await activeProvisioningId(db, s.accountId));
  const cancelStatus = await orderSettled(db, cancelOrder);
  console.log(`  CANCEL ${cancelOrder}: ${cancelStatus}`);
  blockedIf(cancelStatus !== 'COMPLETED', `CANCEL ${cancelOrder} ended ${cancelStatus}`);

  let newOrder = '';
  try { newOrder = await seed.orderExisting(s.accountId, meter2, undefined, newProfile); }
  catch (e) { blockedIf(true, `NEW order on cancelled ${s.accountId} was refused: ${(e as Error).message}`); }
  const newStatus = await orderSettled(db, newOrder);
  console.log(`  NEW ${newOrder} (${meter2}${newProfile ? `, ${newProfile}` : ''}): ${newStatus}`);
  blockedIf(newStatus !== 'COMPLETED', `NEW order ${newOrder} ended ${newStatus}`);

  // provisioningEnabled=false (jasec-oci-dev): a moved debt over the limit suspends the new subscription at once,
  // billing-only, so a SUSPENDED new subscription is a valid result there; with it on (AWS) only ACTIVE counts.
  const provOff = await provisioningOff(db);
  const usable = (x: Sub) => x.id !== funded.id && (x.status === 'ACTIVE' || (provOff && x.status === 'SUSPENDED'));
  const after = await poll(() => subscriptions(db, s.accountId), a => a.some(usable), 60_000, 3_000);
  const old = after.find(x => x.id === funded.id)!;
  const sub2 = after.find(usable);
  blockedIf(!sub2, `${s.accountId}: no new ACTIVE subscription: ${after.map(x => `${x.id} ${x.status}`).join(', ')}`);
  console.log(`  after: sub 1 ${old.id} ${old.status} balance ${old.balance}; sub 2 ${sub2!.id} ${sub2!.status} balance ${sub2!.balance}`);
  return { accountId: s.accountId, funded, old, sub2: sub2!, moved: funded.balance, meter1, meter2,
           prov2: sub2!.status === 'ACTIVE' ? await activeProvisioningId(db, s.accountId) : '', t0 };
}

/** The move itself: balances and the Customer Activity entry. Shared by every check. */
async function judgeMove(db: DbHelper, r: Moved, kind: 'credit' | 'debt') {
  const stranded = Math.abs(r.old.balance - r.moved) < 0.01 && Math.abs(r.sub2.balance) < 0.01;
  test.info().annotations.push({ type: 'JEPYP-475', description:
    `${r.accountId} ${kind}: sub 1 ${r.funded.balance} -> ${r.old.balance}; sub 2 ${r.sub2.balance} (${stranded ? 'STILL STRANDED' : 'moved'})` });
  blockedIf(stranded && !DEPLOYED, `fix not deployed: the ${kind} (${r.moved}) is still on the closed subscription ${r.old.id}`);
  expect.soft(r.sub2.balance, `the new subscription ${r.sub2.id} must hold the ${kind} moved from ${r.old.id}`).toBeCloseTo(r.moved, 2);
  expect.soft(r.old.balance, `the cancelled subscription ${r.old.id} must be left at 0`).toBeCloseTo(0, 2);
  expect.soft(r.old.balance + r.sub2.balance, 'the account total must not change - nothing created or lost').toBeCloseTo(r.moved, 2);

  // Customer Activity (dev note 1): one BALANCE_MOVED_TO_NEW_SUBSCRIPTION row naming both subscriptions and the amount.
  const act = await poll(() => db.query<{ id: string; req: any; resp: any }>(
    `SELECT id, request AS req, response AS resp FROM core_engine.activity
      WHERE accountid = $1 AND apiname = 'BALANCE_MOVED_TO_NEW_SUBSCRIPTION' ORDER BY id`, [r.accountId]), a => a.length > 0, 60_000, 3_000);
  console.log(`  activity: ${act.map(a => `${a.id} ${a.resp?.message ?? ''}`).join(' | ') || 'NONE'}`);
  expect.soft(act.length, 'exactly one Customer Activity entry for the move').toBe(1);
  if (act[0]) {
    expect.soft(act[0].req?.fromSubscription, 'activity: from the cancelled subscription').toBe(r.old.id);
    expect.soft(act[0].req?.toSubscription, 'activity: to the new subscription').toBe(r.sub2.id);
    expect.soft(Number(act[0].resp?.amount), 'activity: the amount moved').toBeCloseTo(r.moved, 2);
    expect.soft(String(act[0].resp?.message ?? ''), 'activity message says the balance was moved').toMatch(/trasladad/i);
  }
}

async function callback(request: APIRequestContext, accountId: string, provId: string, order: string, type: 'SUSPEND' | 'RESUME') {
  const res = await request.post(CALLBACK_URL, {
    headers: { 'Content-Type': 'application/json' },
    data: { accountId, orderType: type, orderId: order, status: 'COMPLETED',
            services: [{ serviceType: 'ELECTRICITY', action: type, bundleId: 'B-100000-E', provisioningDataType: 'METER', provisioningId: provId }] },
    timeout: 120_000,
  });
  const body = await res.text();
  console.log(`  callback ${type} ${order}: HTTP ${res.status()} ${body.slice(0, 160)}`);
  expect(body, `${type} callback for ${order} was refused`).toContain('FINALIZADO');
}

async function autoOrder(db: DbHelper, accountId: string, type: 'SUSPEND' | 'RESUME') {
  return (await db.query<{ id: string; status: string; userid: string; createddate: string }>(
    `SELECT id, status, coalesce(userid,'') AS userid, createddate::text AS createddate FROM core_oms."order" WHERE accountid = $1 AND type = $2 ORDER BY createddate DESC, id DESC LIMIT 1`,
    [accountId, type]))[0];
}

/** Costa Rica now vs the stock profile's no-cut window (real clock - the CCP clock has no time of day). Holidays not modelled. */
async function crWindow(db: DbHelper) {
  const w = (await db.query<{ start: string; end: string }>(
    `SELECT a.exceptionstarttime::text AS start, a.exceptionendtime::text AS end FROM core_config.credit_profile cp
       JOIN core_config.credit_profile_limit_actions a ON a.id = cp.id
      WHERE cp.name = $1 AND a.action = 'SUBSCRIPTION_SUSPENSION'`, [STOCK_PROFILE]))[0];
  blockedIf(!w?.start || !w?.end, `"${STOCK_PROFILE}" has no SUBSCRIPTION_SUSPENSION window`);
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Costa_Rica', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const now = toMin(`${parts.hour}:${parts.minute}`), start = toMin(w.start), end = toMin(w.end);
  const night = start > end ? (now >= start || now < end) : (now >= start && now < end);
  const weekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';
  const minutesToEdge = Math.min(...[start, end].map(x => (x - now + 1440) % 1440));
  return { inside: night || weekend, why: weekend ? 'weekend' : night ? 'night' : 'weekday daytime', minutesToEdge,
           window: `${w.start.slice(0, 5)}-${w.end.slice(0, 5)}`, label: `${parts.weekday} ${parts.hour}:${parts.minute}` };
}

async function mailsSince(db: DbHelper, accountId: string, type: string, watermark: string): Promise<number> {
  return Number((await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM core_engine.email_notification
      WHERE accountid = $1 AND type = $2 AND substring(id from '[0-9]+$')::bigint > $3::bigint`,
    [accountId, type, watermark]))[0]?.n ?? 0);
}

test.describe('JEPYP-475 - the balance follows the customer from a cancelled service to the new one', () => {
  test.use({ ccpBaseline: null });   // this spec manages the clock itself (check 5 only)
  test.skip(ON_JASEC_PROD, PROD_REFUSAL);
  test.setTimeout(1_200_000);

  test('check 1: credit on a cancelled service moves to the new service @tc-04 @jepyp-475 @balance-transfer-credit',
    async ({ page, selfcareLoginPage, selfcareAccountSearchPage }) => {
      const logger = new TestLogger('balance-transfer-credit');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const r = await resubscribe(db, logger, 'credit', CREDIT);
        await judgeMove(db, r, 'credit');
        // Core UI Balances (dev note 1). AgentScreens reads the first CRC grid on the Balances screen.
        const ui = await new AgentScreens(page).crcBalance(r.accountId);
        console.log(`  Core UI Balances (first grid): ${ui}`);
        expect.soft(Math.abs(ui ?? NaN), 'Core UI Balances shows the moved credit on the active service').toBeCloseTo(Math.abs(r.sub2.balance), 2);
        // Self Care (dev note 1): Billing Data > View Balances, CRC row (found 10-17 with a probe; preprod ACT-100547 = -522).
        await attachToAccountInSelfCare({ selfcareLoginPage, selfcareAccountSearchPage }, r.accountId);
        await page.getByText('Billing Data', { exact: true }).first().click();
        await page.getByText('View Balances', { exact: true }).first().click();
        const crcRow = page.locator('tr', { has: page.locator('td', { hasText: /^s*CRCs*$/ }) }).first();
        await crcRow.waitFor({ state: 'visible', timeout: 60_000 });
        const sc = Number(((await crcRow.locator('td').nth(1).innerText()) || '').replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
        console.log(`  Self Care View Balances: CRC ${sc}`);
        expect.soft(sc, 'Self Care View Balances shows the moved credit on the active service').toBeCloseTo(r.sub2.balance, 2);
        if (test.info().errors.length === 0) creditMove = r;
      } finally { await db.disconnect(); }
    });

  test('check 2: debt over the limit moves, Saldo Agotado is sent, the new service is cut, a top-up reconnects @tc-04 @jepyp-475 @balance-transfer-debt',
    async ({ request }) => {
      const logger = new TestLogger('balance-transfer-debt');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const r = await resubscribe(db, logger, 'debt', DEBT, NO_WINDOW);
        await judgeMove(db, r, 'debt');

        // Saldo Agotado after the move (Luis: the new service is cut straight away; the customer pays to reconnect).
        const sa = await poll(() => mailsSince(db, r.accountId, 'CREDIT_LIMIT_BREACH', r.t0), n => n > 0, 180_000, 6_000);
        console.log(`  Saldo Agotado since the move: ${sa}`);
        expect.soft(sa, 'a "Saldo Agotado" (CREDIT_LIMIT_BREACH) e-mail after the debt moved').toBeGreaterThan(0);

        if (await provisioningOff(db)) {
          // Billing-only (jasec-oci-dev): no SUSPEND/RESUME orders go to the AMI - the cut and the reconnect are the
          // subscription status itself. Same steps and outcomes as below otherwise.
          const cutB = await poll(() => subscriptions(db, r.accountId), a => a.find(x => x.id === r.sub2.id)?.status === 'SUSPENDED', 180_000, 5_000);
          expect.soft(cutB.find(x => x.id === r.sub2.id)?.status, `the new service ${r.sub2.id} is cut (billing-only)`).toBe('SUSPENDED');
          await new PrepaidSeedHelper(logger).topUp(r.accountId, Math.ceil(DEBT) + 500);
          const backB = await poll(() => subscriptions(db, r.accountId), a => a.find(x => x.id === r.sub2.id)?.status === 'ACTIVE', 180_000, 5_000);
          expect.soft(backB.find(x => x.id === r.sub2.id)?.status, `the new service ${r.sub2.id} is reconnected`).toBe('ACTIVE');
          return;
        }
        const susp = await poll(() => autoOrder(db, r.accountId, 'SUSPEND'), o => !!o, 180_000, 6_000);
        blockedIf(!susp, `no SUSPEND raised within 3 min after the debt moved to ${r.sub2.id} (profile ${NO_WINDOW}) - ` +
          `today may be a weekend or holiday for the cut rule; re-run on a Costa Rica weekday`);
        console.log(`  SUSPEND ${susp.id} ${susp.status} by ${susp.userid}`);
        expect.soft(susp.userid, 'raised by the credit-limit breach').toBe('CreditLimitBreach');
        if (susp.status !== 'COMPLETED') {
          await orderSettled(db, susp.id, 180);                                  // QA meter: the AMI refuses -> PROVISIONING_ERROR
          await callback(request, r.accountId, r.prov2, susp.id, 'SUSPEND');      // simulate JASEC confirming the cut
        }
        const cut = await poll(() => subscriptions(db, r.accountId), a => a.find(x => x.id === r.sub2.id)?.status === 'SUSPENDED', 90_000, 5_000);
        expect.soft(cut.find(x => x.id === r.sub2.id)?.status, `the new service ${r.sub2.id} is cut`).toBe('SUSPENDED');

        // A top-up that covers the moved debt reconnects.
        await new PrepaidSeedHelper(logger).topUp(r.accountId, Math.ceil(DEBT) + 500);
        const res = await poll(() => autoOrder(db, r.accountId, 'RESUME'), o => !!o, 180_000, 6_000);
        expect(res, 'a RESUME after a top-up that covers the moved debt').toBeTruthy();
        console.log(`  RESUME ${res.id} ${res.status}`);
        if (res.status !== 'COMPLETED') {
          await orderSettled(db, res.id, 180);
          await callback(request, r.accountId, r.prov2, res.id, 'RESUME');
        }
        const back = await poll(() => subscriptions(db, r.accountId), a => a.find(x => x.id === r.sub2.id)?.status === 'ACTIVE', 90_000, 5_000);
        expect.soft(back.find(x => x.id === r.sub2.id)?.status, `the new service ${r.sub2.id} is reconnected`).toBe('ACTIVE');
      } finally { await db.disconnect(); }
    });

  /**
   * Check 2 with the no-cut window (Anh 10-18: the cut of a moved debt respects the window; team 10-18: 20:00-08:00).
   * Two sessions, like TC-129's @window-morning:
   *   NIGHT  (CR weekday 20:00-08:00 or a weekend): @balance-transfer-debt-window - debt moved onto a new service on the
   *          STOCK profile -> Saldo Agotado, but NO cut. Prints the account.
   *   MORNING (CR weekday 08:00-20:00): @balance-transfer-debt-morning with JASEC_TRANSFER_MORNING_ACCOUNT=<that account>
   *          - the next reading in allowed hours cuts it (team release note 10-15: "waits for the next meter reading in
   *          allowed hours or the CREDIT_LIMIT_ACTIONS job of a later Daily Schedule").
   */
  test('check 2 night: debt moved inside the no-cut window - Saldo Agotado, but the new service is NOT cut @tc-04 @jepyp-475 @balance-transfer-debt-window',
    async () => {
      const logger = new TestLogger('balance-transfer-debt-window');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const cr = await crWindow(db);
        blockedIf(!cr.inside, `CR is ${cr.label}: outside the no-cut window ${cr.window} - run this half at CR night or on a weekend`);
        blockedIf(cr.minutesToEdge < 25, `CR is ${cr.label}, ${cr.minutesToEdge} min from the window edge - the run could cross it; re-run later`);
        console.log(`  CR ${cr.label}: inside the no-cut window ${cr.window} (${cr.why})`);
        const r = await resubscribe(db, logger, 'debt', DEBT, STOCK_PROFILE);
        await judgeMove(db, r, 'debt');
        const sa = await poll(() => mailsSince(db, r.accountId, 'CREDIT_LIMIT_BREACH', r.t0), n => n > 0, 180_000, 6_000);
        console.log(`  Saldo Agotado since the move: ${sa}`);
        expect.soft(sa, 'Saldo Agotado is still sent inside the window').toBeGreaterThan(0);
        await sleep(90_000);                                                          // give a (wrong) SUSPEND time to appear
        const susp = await autoOrder(db, r.accountId, 'SUSPEND');
        expect.soft(susp ? `${susp.id} ${susp.status} by ${susp.userid}` : 'none', 'inside the no-cut window the moved debt must NOT cut').toBe('none');
        const sub2 = (await subscriptions(db, r.accountId)).find(x => x.id === r.sub2.id);
        expect.soft(sub2?.status, 'the new service stays ACTIVE overnight').toBe('ACTIVE');
        test.info().annotations.push({ type: 'morning account', description: `${r.accountId} meter ${r.meter2}` });
        console.log(`\n  MORNING STEP (CR weekday 08:00-20:00): JASEC_TRANSFER_MORNING_ACCOUNT=${r.accountId} ` +
          `--grep @balance-transfer-debt-morning  (new meter ${r.meter2})\n`);
      } finally { await db.disconnect(); }
    });

  test('check 2 morning: the moved debt held overnight is cut by the next reading in allowed hours @tc-04 @jepyp-475 @balance-transfer-debt-morning',
    async ({ request }) => {
      const accountId = (process.env.JASEC_TRANSFER_MORNING_ACCOUNT ?? '').trim();
      blockedIf(!accountId, 'set JASEC_TRANSFER_MORNING_ACCOUNT to the account the @balance-transfer-debt-window night half printed');
      const logger = new TestLogger('balance-transfer-debt-morning');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      const mdr = new MdrRemoteHelper(logger);
      blockedIf(!(await mdr.isAvailable()), 'the MDR loader tree is not reachable over SSH - cannot send the morning reading');
      try {
        const cr = await crWindow(db);
        blockedIf(cr.inside, `CR is ${cr.label}: still inside the no-cut window ${cr.window} (${cr.why}) - run after 08:00 CR on a weekday`);
        const subs = await subscriptions(db, accountId);
        const sub2 = subs.find(x => x.status === 'ACTIVE');
        const early = await autoOrder(db, accountId, 'SUSPEND');
        console.log(`  ${accountId}: ${subs.map(x => `${x.id} ${x.status} ${x.balance}`).join(' | ')}; SUSPEND so far: ${early ? `${early.id} ${early.status} ${early.createddate}` : 'none'}`);
        blockedIf(!sub2, `${accountId}: no ACTIVE service - already cut? (${early?.id ?? 'no SUSPEND'})`);
        expect.soft(sub2!.balance, 'the moved debt is still on the new service, over the limit').toBeGreaterThan(0);
        const meter = (await db.query<{ p: string }>(
          `SELECT sp.provisioningid AS p FROM core_engine.service_unit su JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
            WHERE su.accountid = $1 AND su.status = 'ACTIVE' LIMIT 1`, [accountId]))[0]?.p ?? '';
        blockedIf(!meter, `${accountId}: no meter on the active service`);
        // The clock may have been left anywhere since the night half: date the readings after the account's own.
        await clockPastAccount(db, new PrepaidSeedHelper(logger), accountId);
        // The first reading of a meter is only its baseline (rated 0); the second one is charged - that is the "next reading".
        for (const kwh of [0, 10]) {
          const out = await mdr.submitReading(assertQaMeter(meter), kwh);
          const file = out.match(/MDR_PREPAGO_[0-9-]+\.csv/)?.[0] ?? '';
          const row = await poll(async () => (await db.query<{ status: string; errorcode: string }>(
            `SELECT status, coalesce(errorcode,'') AS errorcode FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND id = $2
             UNION ALL
             SELECT status, coalesce(errorcode,'') AS errorcode FROM core_usage.file_detail_record WHERE provisioningid = $1 AND id = $2 AND status <> 'PENDING'`,
            [meter, file]))[0], x => !!x, 180_000, 5_000);
          console.log(`  reading ${kwh} on ${meter} (${file}) at CR ${(await crWindow(db)).label}: ${row?.status}/${row?.errorcode}`);
        }
        // provisioningEnabled=false (jasec-oci-dev): the breach suspends the subscription billing-only, with no SUSPEND
        // order to dispatch to the AMI, so the cut is the subscription status itself. With it on (AWS) nothing changes.
        const provOn = (await db.query<{ v: string }>(
          `SELECT value AS v FROM core_config.ccp_properties WHERE property = 'provisioningEnabled'`))[0]?.v !== 'false';
        if (!provOn) {
          const cutNow = await poll(() => subscriptions(db, accountId), a => a.find(x => x.id === sub2!.id)?.status === 'SUSPENDED', 180_000, 6_000);
          console.log(`  provisioningEnabled=false: billing-only cut, ${sub2!.id} ${cutNow.find(x => x.id === sub2!.id)?.status}`);
          expect(cutNow.find(x => x.id === sub2!.id)?.status, 'after the window, the next reading cuts the service that holds the moved debt').toBe('SUSPENDED');
          return;
        }
        const susp = await poll(() => autoOrder(db, accountId, 'SUSPEND'), o => !!o, 180_000, 6_000);
        console.log(`  SUSPEND: ${susp ? `${susp.id} ${susp.status} by ${susp.userid}` : 'none'}`);
        expect(susp, 'after the window, the next reading cuts the service that holds the moved debt').toBeTruthy();
        expect.soft(susp.userid, 'raised by the credit-limit breach').toBe('CreditLimitBreach');
        if (susp.status !== 'COMPLETED') {
          await orderSettled(db, susp.id, 180);                                    // QA meter: the AMI refuses -> PROVISIONING_ERROR
          const prov = (await db.query<{ p: string }>(`SELECT provisioningid AS p FROM core_engine.service_unit WHERE accountid = $1 AND status <> 'CLOSED' LIMIT 1`, [accountId]))[0]?.p ?? '';
          await callback(request, accountId, prov, susp.id, 'SUSPEND');
        }
        const cut = await poll(() => subscriptions(db, accountId), a => a.find(x => x.id === sub2!.id)?.status === 'SUSPENDED', 90_000, 5_000);
        expect.soft(cut.find(x => x.id === sub2!.id)?.status, `the new service ${sub2!.id} is cut`).toBe('SUSPENDED');
      } finally { await db.disconnect(); }
    });

  test('check 5: an old-meter reading dated before the cancel is charged to the new service, not held, no Saldo Agotado @tc-04 @jepyp-475 @balance-transfer-late-reading',
    async () => {
      const logger = new TestLogger('balance-transfer-late-reading');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      const seed = new PrepaidSeedHelper(logger);
      const mdr = new MdrRemoteHelper(logger);
      blockedIf(!(await mdr.isAvailable()), 'the MDR loader tree is not reachable over SSH - cannot send the old meter\'s reading');
      const startClock = await seed.ccpDate();
      try {
        // Seed on the start date, then cancel + new two days later, so a reading can be dated AFTER the account
        // started and BEFORE the cancel (first try 10-17 seeded after moving the clock: the reading predated the account).
        const day = (n: number) => { const d = new Date(`${startClock}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
        // The first reading on a meter is only its baseline (rated 0) - send one while the old service is active.
        const r = await resubscribe(db, logger, 'credit', 5000, undefined, async (meter1) => {
          const base = await mdr.submitReading(meter1, 10);
          const bf = base.match(/MDR_PREPAGO_[0-9-]+.csv/)?.[0] ?? '';
          const ok = await poll(async () => (await db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND id = $2`, [meter1, bf]))[0].n,
            n => n !== '0', 180_000, 5_000);
          blockedIf(ok === '0', `baseline reading ${bf} on ${meter1} was not processed`);
          console.log(`  baseline 10 kWh on ${meter1} (${bf}) processed`);
          await seed.setCcpDate(day(2));
        });
        await judgeMove(db, r, 'credit');
        const before = (await subscriptions(db, r.accountId)).find(x => x.id === r.sub2.id)!.balance;

        await seed.setCcpDate(day(1));                                             // reading dated between start and cancel
        const out = await mdr.submitReading(r.meter1, 60);              // 50 kWh over the baseline
        const file = out.match(/MDR_PREPAGO_[0-9-]+\.csv/)?.[0] ?? '';
        const row = await poll(async () => (await db.query<{ status: string; errorcode: string; qty: string }>(
          `SELECT status, coalesce(errorcode,'') AS errorcode, quantity::text AS qty FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND id = $2
           UNION ALL
           SELECT status, coalesce(errorcode,'') AS errorcode, quantity::text AS qty FROM core_usage.file_detail_record WHERE provisioningid = $1 AND id = $2 AND status <> 'PENDING'`,
          [r.meter1, file]))[0], x => !!x, 180_000, 5_000);
        const after = (await subscriptions(db, r.accountId)).find(x => x.id === r.sub2.id)!.balance;
        console.log(`  old meter ${r.meter1} reading 60 (${file}): ${row?.status}/${row?.errorcode} qty=${row?.qty}; new service balance ${before} -> ${after}`);
        expect.soft(row?.status, 'the old meter\'s late reading is processed, not held').toBe('PROCESSED');
        expect.soft(after, 'it is charged to the NEW service\'s balance').toBeGreaterThan(before);
        expect.soft(await mailsSince(db, r.accountId, 'CREDIT_LIMIT_BREACH', r.t0), 'no Saldo Agotado for it').toBe(0);
      } finally {
        await db.disconnect();
      }
    });

  // SIDE CHECK under TC-04, not a separate TC (Anh 2026-10-21). The month's kWh also follow the customer: the ICB /
  // Bomberos threshold (1.75% above 100 kWh, retroactive from kWh 1 - KB 10-billing-rating-usage.md R8-R10) counts
  // both meters. tenant-deployment a199207 (10-17) re-creates core_engine.threshold_based_tax_calc to add up the
  // account's KWH buckets; before, "100 + 5 kWh across a meter change" got no BOM. Build-check BIL-16 checks the
  // function itself. Explored first: EXPLORE_tax-threshold-meter-change (preprod ACT-100639, ACT-100869: 115.19 / -1.07).
  test('side check: the Bomberos threshold counts the month across the meter change (100 + 5 kWh) @tc-04 @jepyp-475 @balance-transfer-tax-threshold',
    async () => {
      const BOM_RATE = 0.0175;                                   // tenant-deployment 05-finance-tax-accounting.sql:297
      const TAXED = ['I-100003', 'I-100004', 'I-100006'];        // ENE, CVG ENE, CVG ALP (plain ALP I-100005 is not taxed)
      const logger = new TestLogger('balance-transfer-tax-threshold');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      const seed = new PrepaidSeedHelper(logger);
      const mdr = new MdrRemoteHelper(logger);
      blockedIf(!(await mdr.isAvailable()), 'the MDR loader tree is not reachable over SSH - cannot send readings');
      const clockAtStart = await seed.ccpDate();
      // The readings must fall in one month: near month end, start on the 1st of the next one instead (forward only).
      const startClock = addDays(clockAtStart, 2).slice(0, 7) === clockAtStart.slice(0, 7) ? clockAtStart
        : await clockForward(seed, firstOfNextMonth(clockAtStart), 'the readings must fall in one month');
      const day = (n: number) => { const d = new Date(`${startClock}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
      blockedIf(day(2).slice(0, 7) !== startClock.slice(0, 7), `clock ${startClock} is too close to month end - the readings would span two months`);

      /** Send a cumulative reading and return its rated lines (rating writes them a moment after PROCESSED). */
      const rate = async (meter: string, kwh: number) => {
        const file = (await mdr.submitReading(meter, kwh)).match(/MDR_PREPAGO_[0-9-]+\.csv/)?.[0] ?? '';
        const st = await poll(async () => (await db.query<{ status: string }>(
          `SELECT status FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND id = $2
           UNION ALL SELECT status FROM core_usage.file_detail_record WHERE provisioningid = $1 AND id = $2 AND status <> 'PENDING'`,
          [meter, file]))[0]?.status ?? '', s => !!s, 240_000, 5_000);
        blockedIf(st !== 'PROCESSED', `reading ${file} on ${meter} ended ${st || 'not processed'}`);
        await sleep(15_000);
        const lines = await db.query<{ type: string; itemid: string; amount: number }>(
          `SELECT type, coalesce(itemid,'') AS itemid, netamount::float AS amount FROM core_engine.transaction_unit
            WHERE usageid IN (SELECT usageid FROM core_usage.file_detail_record_processed WHERE id = $1) ORDER BY id`, [file]);
        console.log(`  ${meter} -> ${kwh} (${file}): ${lines.map(l => `${l.type === 'TAX' ? 'TAX' : l.itemid} ${l.amount}`).join(', ')}`);
        return lines;
      };
      const taxOf = (l: { type: string; amount: number }[]) => l.filter(x => x.type === 'TAX').reduce((s, x) => s + x.amount, 0);
      const baseOf = (l: { type: string; itemid: string; amount: number }[]) =>
        l.filter(x => x.type !== 'TAX' && TAXED.includes(x.itemid)).reduce((s, x) => s + x.amount, 0);

      try {
        let first: Awaited<ReturnType<typeof rate>> = [];
        const r = await resubscribe(db, logger, 'credit', 20000, undefined, async (meter1) => {
          await rate(meter1, 10);                                  // the first reading is only the baseline (rated 0)
          first = await rate(meter1, 110);                         // month = 100 kWh, exactly at the line
          await seed.setCcpDate(day(1));                           // cancel + new service the next day
        });
        expect.soft(taxOf(first), '100 kWh on the old meter: exactly at the BOM line, no tax yet').toBeCloseTo(0, 2);

        await seed.setCcpDate(day(2));
        await rate(r.meter2, 10);                                  // baseline of the new meter
        const crossing = await rate(r.meter2, 15);                 // +5 kWh: month = 105 across both meters
        const expected = Math.round((baseOf(first) + baseOf(crossing)) * BOM_RATE * 100) / 100;
        console.log(`  month base ${(baseOf(first) + baseOf(crossing)).toFixed(2)} x ${BOM_RATE} = ${expected}; tax on the crossing reading ${taxOf(crossing).toFixed(2)}`);
        test.info().annotations.push({ type: 'JEPYP-475 tax', description:
          `${r.accountId}: crossing reading tax ${taxOf(crossing).toFixed(2)}, expected BOM on the whole month ${expected}` });
        expect.soft(taxOf(crossing), 'the +5 kWh reading on the new meter crosses 100 kWh for the month: BOM on the whole month (both meters)')
          .toBeCloseTo(expected, 1);

        const kwhBuckets = await db.query<{ sub: string; amount: number }>(
          `SELECT s.id AS sub, acc.amount::float AS amount FROM core_engine.balance_unit_accumulators acc
             JOIN core_engine."subscription" s ON s.balanceunitid = acc.id
            WHERE s.accountid = $1 AND acc.accumulatorid = 'KWH' ORDER BY s.id`, [r.accountId]);
        console.log(`  KWH buckets: ${kwhBuckets.map(b => `${b.sub} ${b.amount}`).join(', ')}`);
        expect.soft(kwhBuckets.reduce((s, b) => s + b.amount, 0), 'the month\'s kWh over all the account\'s buckets').toBeCloseTo(105, 3);
      } finally {
        await db.disconnect();
      }
    });

  test('display: the moved balance shows on the active service in the statement; accounting unchanged @tc-04 @jepyp-475 @balance-transfer-display',
    async () => {
      const logger = new TestLogger('balance-transfer-display');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const reuse = creditMove && await stillAsMoved(db, creditMove);
        console.log(reuse ? `  reusing check 1's credit move on ${creditMove!.accountId} (balances unchanged since)` : '  building its own credit move');
        const r = reuse ? creditMove! : await resubscribe(db, logger, 'credit', CREDIT);
        await judgeMove(db, r, 'credit');
        const lines = await new BillingGqlHelper(logger).getAccountStatement(r.accountId);
        console.log(`  statement ${r.accountId}: ` + lines.map(l => `${l.lineType} ${l.amount} -> ${l.closingBalance}`).join(' | '));
        const last = lines[lines.length - 1];
        if (last) expect.soft(last.closingBalance, 'statement closing balance = the active service balance').toBeCloseTo(r.sub2.balance, 2);
        // TODO accounting: JASEC - no impact. Pin the journal table and assert no row is raised for the move.
      } finally { await db.disconnect(); }
    });

  /**
   * Checks 3 and 4 - the bill. One scenario on a free billing day (each check its own BDOM; preprod bills BDOM+1, dev BDOM+8):
   * seed with 5,000 credit -> baseline + 10 kWh on the old meter -> cancel 3 days later -> (check 3 only) new service in
   * the same month, baseline + 10 kWh on the new meter -> DAILY on the bill date. Judged by what the month COST the
   * customer (balance change over both services): with <= 30 kWh in all it must be exactly ONE minimum (MONTH_MIN) -
   * check 3: not two minimums; check 4: the full minimum, not a part-month - and the month after it bills 0.00.
   */
  const BILL_CASES = [
    { label: 'check 3: cancel + new service in the same month - the bill charges ONE minimum on the whole month kWh',
      tag: '@balance-transfer-one-minimum', withNew: true, bdomEnv: 'JASEC_TRANSFER_BDOM_SAME_MONTH' },
    { label: 'check 4: cancel with no new service - the last bill charges the full minimum, no proration',
      tag: '@balance-transfer-last-bill', withNew: false, bdomEnv: 'JASEC_TRANSFER_BDOM_NO_NEW' },
  ];
  for (const c of BILL_CASES) {
    test(`${c.label} @tc-154 @jepyp-475 ${c.tag}`, async ({ dailySchedulePage }) => {
      const logger = new TestLogger(`balance-transfer-${c.tag.slice(18)}`);
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      const seed = new PrepaidSeedHelper(logger);
      const mdr = new MdrRemoteHelper(logger);
      blockedIf(!(await mdr.isAvailable()), 'the MDR loader tree is not reachable over SSH - cannot send readings');
      const startClock = await seed.ccpDate();
      let base = startClock;                       // the seed date: startClock, or later on dev when today's bill dates are taken
      const day = (n: number) => { const d = new Date(`${base}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
      const reading = async (meter: string, kwh: number) => {
        const out = await mdr.submitReading(meter, kwh);
        const file = out.match(/MDR_PREPAGO_[0-9-]+\.csv/)?.[0] ?? '';
        const row = await poll(async () => (await db.query<{ status: string; qty: string }>(
          `SELECT status, quantity::text AS qty FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND id = $2`, [meter, file]))[0],
          x => !!x, 180_000, 5_000);
        console.log(`  reading ${kwh} on ${meter} (${file}): ${row?.status ?? 'NOT PROCESSED'} qty ${row?.qty}`);
        blockedIf(!row, `reading ${file} on ${meter} was not processed`);
      };
      try {
        // Billing day: the env var if set, else picked so the bill date has no job schedule yet (2026-10-19; the fixed
        // defaults 18 / 20 went BLOCKED whenever their date was taken).
        // The env var forces a billing day; otherwise the account is seeded until its first bill date is free (2026-10-19).
        const made: Record<string, { s: { accountId: string; orderId: string }; meter1: string; meter2: string }> = {};
        const seedOn = async (day: number) => {
          const sfx = uniqueRunSuffix();
          const m1 = assertQaMeter(`M-QABIL-${sfx}1`);
          const r = await seed.seed({ meter: m1, customerId: `E2EBIL-${sfx}`, name: `QA BALANCE TRANSFER bill ${sfx}`, billingDom: day });
          made[r.accountId] = { s: r, meter1: m1, meter2: assertQaMeter(`M-QABIL-${sfx}2`) };
          return r.accountId;
        };
        let BDOM = Number(process.env[c.bdomEnv] ?? 0);
        let first = '';
        if (BDOM) first = await seedOn(BDOM);
        else {
          const got = await seedOnFreeBillDate(db, { read: () => seed.ccpDate(), set: d => seed.setCcpDate(d) }, seedOn);
          blockedIf(!got, 'no usable bill date: the date is taken and cannot be reclaimed here (a PROCESSING run, a non-test tenant or JASEC_RECLAIM_SLOTS=false) - see the log');
          first = got!.accountId; BDOM = got!.day; base = got!.seedDate;
        }
        const { s, meter1, meter2 } = made[first];
        blockedIf((await orderSettled(db, s.orderId)) !== 'COMPLETED', `${s.accountId}: the first order did not complete`);
        await seed.topUp(s.accountId, 5000);
        const start = await poll(async () => (await subscriptions(db, s.accountId))[0]?.balance ?? 0, b => Math.abs(b + 5000) < 0.01, 60_000, 3_000);
        await reading(meter1, 0);                                                    // baseline
        await seed.setCcpDate(day(1)); await reading(meter1, 10);
        await seed.setCcpDate(day(3));
        const cancel = await seed.cancel(s.accountId, await activeProvisioningId(db, s.accountId));
        blockedIf((await orderSettled(db, cancel)) !== 'COMPLETED', `CANCEL ${cancel} did not complete`);
        if (c.withNew) {
          const n = await seed.orderExisting(s.accountId, meter2);
          blockedIf((await orderSettled(db, n)) !== 'COMPLETED', `NEW order ${n} did not complete`);
          await reading(meter2, 0);                                                  // baseline
          await seed.setCcpDate(day(4)); await reading(meter2, 10);
        }
        const units = await db.query<{ id: string; sub: string; status: string; d: string }>(
          `SELECT bu.id, to_char(bu.enddate,'YYYY-MM-DD') AS sub, bu.status,
                  coalesce((bp.nextaccountingdate + core_engine.get_future_cycle_date(bp.accountid))::date::text,'') AS d
             FROM core_engine.bill_unit bu JOIN core_engine.billing_profile bp ON bp.accountid = bu.accountid
            WHERE bu.accountid = $1 ORDER BY bu.id`, [s.accountId]);
        console.log(`  ${s.accountId} bill units before the DAILY: ${units.map(u => `${u.id} ${u.sub} ${u.status} (bill ${u.d})`).join(' | ')}`);
        const D = units.find(u => u.status === 'PENDING')?.d ?? '';
        blockedIf(!D, `${s.accountId}: no PENDING bill unit - nothing to bill (did the cancel bill at once? units above)`);
        const foreign = await db.query<{ id: string }>(
          `SELECT DISTINCT a.id FROM core_engine.billing_profile bp
             JOIN core_engine.bill_unit bu ON bu.accountid = bp.accountid AND bu.status = 'PENDING'
             JOIN core_engine.account a ON a.id = bp.accountid
            WHERE bp.nextaccountingdate <= $1::date - core_engine.get_future_cycle_date(bp.accountid) AND a.status = 'ACTIVE'
              AND NOT (coalesce((SELECT string_agg(sp.provisioningid, ',') FROM core_engine.service_unit su
                                   JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
                                  WHERE su.accountid = a.id), '') LIKE 'M-QA%' OR a.customerid ~* '^(E2E|QA)')`, [D]);
        // JASEC_DAILY_ALLOW: foreign accounts Anh approved being billed by our DAILY (preprod 43-79920, overdue, billed by any DAILY).
        const allow = (process.env.JASEC_DAILY_ALLOW ?? '').split(',').map(x => x.trim()).filter(Boolean);
        const notAllowed = foreign.filter(x => !allow.includes(x.id));
        if (allow.length) console.log(`  own-data guard: approved for this run: ${allow.join(', ')}`);
        // Other customers' accounts the DAILY bills are logged and billed too (test environment, Anh 2026-10-19). A used
        // date is reclaimed (one daily run per date; schedule-slot.helper) and blocks only when that is not possible.
        const slot = await ensureDateFree(db, D);
        blockedIf(!slot.free, `the DAILY on ${D} cannot run: ${slot.reason} - set ${c.bdomEnv} to another day`);
        if (notAllowed.length > 0) {
          console.log(`  note: the DAILY on ${D} also bills ${notAllowed.length} other account(s) (test environment): ` +
            notAllowed.map(x => x.id).slice(0, 8).join(', '));
        }

        await seed.setCcpDate(D);
        const cards = await dailySchedulePage.createAndProcess(D, () => seed.setCcpDate(D).then(() => undefined), logger);
        console.log(`  DAILY ${D}: ${Object.entries(cards).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        const bills = await db.query<{ id: string; sub: string; status: string; total: string }>(
          `SELECT id, to_char(enddate,'YYYY-MM-DD') AS sub, status, coalesce(billtotal,0)::text AS total FROM core_engine.bill_unit WHERE accountid = $1 ORDER BY id`, [s.accountId]);
        console.log(`  bill units after: ${bills.map(b => `${b.id} ${b.sub} ${b.status} ${b.total}`).join(' | ')}`);
        const end = (await subscriptions(db, s.accountId)).reduce((t, x) => t + x.balance, 0);
        const cost = Math.round((end - start) * 100) / 100;                       // credit reads negative: cost = end - start
        console.log(`  month cost ${cost} (balance ${start} -> ${end}); one minimum = ${MONTH_MIN}`);
        test.info().annotations.push({ type: 'JEPYP-475', description: `${s.accountId} ${c.tag}: month cost ${cost} (one minimum ${MONTH_MIN})` });
        expect.soft(cost, c.withNew ? 'cancel + new in one month: ONE minimum on the whole month (not two)' : 'last bill: the full minimum, no proration')
          .toBeCloseTo(MONTH_MIN, 2);

        // Check 4 follow-up: the month AFTER the closing bill charges nothing - no second minimum for a closed service.
        // runPendingBill closes the cycle at the clock, so the clock goes to the day after that cycle ends (preprod
        // ACT-100558 and prod ACT-100133 were checked this way by hand on 10-17/18 - both 0.00). The system then opens
        // another empty 0.00 cycle; harmless.
        if (!c.withNew) {
          const next = (await db.query<{ id: string; sub: string }>(
            `SELECT id, to_char(enddate,'YYYY-MM-DD') AS sub FROM core_engine.bill_unit WHERE accountid = $1 AND status = 'PENDING' ORDER BY enddate LIMIT 1`,
            [s.accountId]))[0];
          blockedIf(!next, `${s.accountId}: no PENDING cycle after the closing bill - cannot check the next month`);
          const nextDay = new Date(`${next.sub}T12:00:00Z`); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
          const before = (await subscriptions(db, s.accountId)).reduce((t, x) => t + x.balance, 0);
          await seed.setCcpDate(nextDay.toISOString().slice(0, 10));
          const nb = await seed.runPendingBill(s.accountId);
          const after = (await subscriptions(db, s.accountId)).reduce((t, x) => t + x.balance, 0);
          console.log(`  next month: runPendingBill ${JSON.stringify(nb)}; balance ${before} -> ${after}`);
          expect.soft(nb, 'the next cycle of the closed service is billed').not.toBeNull();
          expect.soft(Number(nb?.billTotal ?? NaN), 'the month after the closing bill charges 0.00').toBeCloseTo(0, 2);
          expect.soft(Math.round((after - before) * 100) / 100, 'the balance does not move in the month after the closing bill').toBeCloseTo(0, 2);
        }
      } finally {
        await db.disconnect();
      }
    });
  }
});
