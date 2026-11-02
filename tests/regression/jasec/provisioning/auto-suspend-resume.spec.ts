/**
 * JEPYP-27, the AUTOMATIC path: balance runs out -> the system raises a SUSPEND
 * -> JASEC cut the meter -> top-up -> the system raises a RESUME -> JASEC
 * reconnect. This is what production does most, and until 2026-09-28 nothing
 * exercised it with provisioning switched on: ts-06 test B was written when
 * provisioningEnabled was absent on dev, so a breach suspended for billing only
 * and no order ever reached the AMI.
 *
 * EIGHT TESTS, run one tag at a time (each is several minutes):
 *
 *   @auto-journey   TC-131 (EPDP-515, official since 2026-10-08): a customer cut off for a
 *                   reading the balance cannot fund is not reconnected until a top-up covers
 *                   the debt. Clean account (no NISE): breach (billed into debt) ->
 *                   CreditLimitBreach SUSPEND -> 4 refused D commands -> callback -> NO RESUME
 *                   (A6) -> reading while cut refused -> partial top-up, still cut -> covering
 *                   top-up pays the debt -> automatic RESUME -> 4 refused C commands -> callback
 *                   -> next reading bills only the new kWh and closes the refused one.
 *                   Asserts both orders COMPLETED and the account back to ACTIVE.
 *   @auto-nise      the same journey on an account shaped like the Create Account
 *                   screen makes it (NISE in clientId); the automatic orders must
 *                   carry no clientid (order_clientid_fkey fixed, engine 4f16ffb9f).
 *   @auto-race      TC-128 (scenario doc TC40): the customer tops up BEFORE JASEC's
 *                   suspend callback. Asserts the end state (account ACTIVE, no order
 *                   left open) and prints the order timeline. Cut-then-reconnect is the
 *                   intended behaviour (EP-5480).
 *   @auto-window    TC-129: the stock profile's no-cut window, judged against real
 *                   Costa Rica time (inside: no SUSPEND; outside: SUSPEND). The
 *                   "morning after" half (scenario doc TC41) is @window-morning.
 *   @window-daily   TC-130 (A8, fixed 2026-10-16): a breach held overnight is cut by the
 *                   next Daily Schedule after the window ends, with no new reading.
 *   @auto-stuck-resume  TC-132 (EPDP-516, F7): a customer who pays after a failed reconnect
 *                   is reconnected. The RESUME fails at JASEC (no callback), the customer
 *                   tops up again: a reconnect must be attempted again. FIXED 2026-10-09
 *                   (engine 5c5b901 + ccp replaceProvisioningErrorOrders=true): a new RESUME,
 *                   the failed one CANCELLED + renamed, one AUTO_ORDER_REPLACED_FAILED row.
 *                   Without the fix it falls back to CANCEL ORDER on the Services screen.
 *   @auto-stuck-suspend TC-133 (EPDP-517, F7 mirror): a customer out of credit is cut off
 *                   even after an earlier cut failed. Same shape on the SUSPEND side.
 *   @auto-skip-and-refuse TC-134 (EPDP-518): no new order while another of its type is open
 *                   or failed - a top-up during an in-progress RESUME is SKIPPED, and a
 *                   manual RESUME on top of a failed one is refused.
 *   @auto-held-cycle  EXPLORATORY: a cut account still in debt stays cut through
 *                   a daily run days later. Own gate JASEC_HELD_CYCLE_RUN (it moves the
 *                   clock and runs the whole DAILY chain), refused on jasec-preprod.
 *
 * JEPYP-482 (fixed on preprod + prod 2026-10-30, retest EXPLORE_held-reading-reprocess): a reading the balance cannot
 * fund is no longer HELD (SUSPENDED / CURRENCY_CREDIT_LIMIT_EXCEEDED, nothing charged). It is BILLED on its day, the
 * balance goes into debt, Saldo Agotado asks base + debt, and the cut follows the same window rules. A reading refused
 * while cut names its account and is closed (HELD_READING_COVERED, "Billed by the reading ...") by the next billed one.
 * The tenant flag throwCreditLimitBreachException is still 'true' - the change is in the engine.
 *
 * A6 (2026-10-07). With countHeldUsageInCreditCheck=true (the engine fix for "reconnect without top-up") the
 * journey also asserts that completing the SUSPEND raises no RESUME, and that a top-up smaller than the held
 * reading leaves the account cut; only the covering top-up reconnects. The fix is live on dev, preprod and prod, so
 * with the switch OFF the journey is BLOCKED (misconfigured tenant) - never a silent pass.
 *
 * O1 - EXPLAINED by the team 2026-10-08, not a defect: a second CreditLimitBreach SUSPEND after a partial top-up was
 * only seen where the first suspend was billing-only (no cut ever sent) and the debt sat in the balance itself. Still
 * recorded as an annotation if it ever shows here, where the first cut is a real one.
 *
 * WHAT IS OBSERVED, NOT ASSERTED. Whether the subscription is suspended when the
 * breach happens or only when the callback arrives. The code routes a
 * provisionable breach through processSubscriptionUpdateOrder and nobody has
 * measured it; the answer is printed and attached so it can become an assertion.
 *
 * SAFETY. Every test seeds its own account on "Prepaid Energy E2E No Window"
 * (a hand-added test fixture - suspends at any hour) with a meter named M-QAAUTO-<suffix>, and
 * refuses to dispatch unless the meter on service_provision has that prefix and
 * has never been answered 00. About 8 refused commands per @auto-journey run.
 * The callback is a direct POST because in production it is JASEC calling us.
 *
 * ON SCREEN (since 2026-10-06). The top-ups stay on the API, but what an agent sees is
 * checked in the Core UI as well as the database: the account's Services screen
 * (subscription status, In-complete Orders), the order detail (Type, Status, User Id =
 * CreditLimitBreach for the system's SUSPEND) and Customer Activity (one row per AMI
 * dispatch attempt, compared with the activity rows in the database).
 *
 * GATED - reaches JASEC's live AMI and drops MDR files through the loader:
 *
 *   $env:JASEC_AUTO_PROV_RUN='true'
 *   npx playwright test --project=jasec-provisioning-orders auto-suspend-resume --grep "@tc-131"
 *
 * Needs VPN, the DB, and SSH to the control server (MDR loader).
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '../../../../fixtures/page-factory';
import type { APIRequestContext, TestInfo } from '@playwright/test';
import { AgentScreens } from '../../../../helpers/agent-screens.helper';
import { DbHelper } from '../../../../helpers/db.helper';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { MdrRemoteHelper } from '../../../../helpers/mdr-remote.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';
import { assertSafeToDispatch as assertMeterSafe } from '../../../../helpers/provisioning-safety.helper';
import { sleep, poll } from '../../../../helpers/poll.helper';
import { dateUsable, ensureDateFree } from '../../../../helpers/schedule-slot.helper';
import { CLOCK_RESTORE, accountLatestDate, addDays, clockPastAccount } from '../../../../helpers/clock-policy';

const RUN = process.env.JASEC_AUTO_PROV_RUN === 'true';
const TENANT = (process.env.TEST_ENV ?? 'jasec-dev').trim();
// Runs on jasec-dev, jasec-preprod and jasec (prod) - this spec drives real suspend/resume commands to the AMI. It used to THROW on any other
// tenant, which on JASEC prod (2026-09-30) took down the whole jasec-provisioning
// project at load (0 tests listed). Now it SKIPS every test with a BLOCKED reason:
// just as fail-closed, without breaking the sibling specs.
// 'jasec' = PROD build 1, opened 2026-10-01 for the provisioning cases: QA meters only (the AMI refuses
// them; we send JASEC's callback ourselves), each case behind its own *_RUN flag, and the
// spec still BLOCKS itself while provisioningEnabled is not true.
const TENANT_REFUSED = !/^jasec(-dev|-preprod)?$/.test(TENANT);
test.skip(() => TENANT_REFUSED,
  `BLOCKED, not failed: this spec drives real suspend/resume commands to the AMI and runs on jasec-dev / jasec-preprod / jasec (prod) only ` +
  `(got '${TENANT}'). On prod it needs provisioningEnabled=true, accepted test meters and an agreed window.`);
const CALLBACK_URL = process.env.JASEC_PROVISION_CALLBACK_URL
  ?? `https://provision-gateway.${TENANT}.embrix.org/updateProvisioningRequest`;

/**
 * The credit profile seeded accounts get. The "E2E No Window" profile is a
 * hand-added test fixture that suspends at any hour (not in the tenant-deployment
 * baseline). It was also found on jasec-preprod on 2026-09-29, but preprod is
 * JASEC's UAT tenant, so there set
 * JASEC_AUTO_PROFILE='Prepaid Energy Profile' and run in Costa Rica daytime on a
 * weekday - preconditions() refuses to start inside that profile's no-cut window.
 */
const PROFILE = process.env.JASEC_AUTO_PROFILE ?? 'Prepaid Energy E2E No Window';
const METER_PREFIX = 'M-QAAUTO-';
const INITIAL_TOPUP = 3300;
const FIRST_READING = 20;      // absolute meter reading; rates ~1,295.60
const BREACH_READING = 200;    // +180 kWh, far above the remaining credit
const RECOVERY_TOPUP = 20000;
const WHILE_SUSPENDED_READING = 230;  // must be REFUSED: no active service unit
const AFTER_RESUME_READING = 260;     // must RATE, and as a meter total it covers
                                      // everything since the last RATED reading (20)

type Seeded = { accountId: string; meter: string; svc: string; sub: string; provId: string };
type Cmd = { id: string; accion: string; medidor: string; answer: string };



// ── setup ────────────────────────────────────────────────────────────────

async function preconditions(db: DbHelper) {
  const props = await db.query<{ property: string; value: string }>(
    `SELECT property, value FROM core_config.ccp_properties
      WHERE property IN ('provisioningEnabled','throwCreditLimitBreachException')`);
  const p = Object.fromEntries(props.map(x => [x.property, x.value]));
  blockedIf(p.provisioningEnabled !== 'true',
    `provisioningEnabled is '${p.provisioningEnabled ?? '<unset>'}' on ${TENANT}: a breach suspends for ` +
    `billing only and no order reaches the AMI, so there is no provisioning flow to test.`);
  blockedIf(p.throwCreditLimitBreachException !== 'true',
    `throwCreditLimitBreachException is '${p.throwCreditLimitBreachException}': this spec's expectations (JEPYP-482: bill ` +
    `into debt, then cut) were verified with it 'true' (preprod + prod, 2026-10-30). Re-derive them first.`);
  const prof = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM core_config.credit_profile WHERE name = $1`, [PROFILE]);
  blockedIf(prof[0]?.n === '0',
    `credit profile "${PROFILE}" does not exist on ${TENANT}. The no-window profile is a hand-added test fixture; ` +
    `on preprod set JASEC_AUTO_PROFILE='Prepaid Energy Profile' and run in Costa Rica daytime.`);
  const w = await db.query<{ start: string; end: string }>(
    `SELECT a.exceptionstarttime::text AS start, a.exceptionendtime::text AS end
       FROM core_config.credit_profile cp JOIN core_config.credit_profile_limit_actions a ON a.id = cp.id
      WHERE cp.name = $1 AND a.action = 'SUBSCRIPTION_SUSPENSION'`, [PROFILE]);
  if (w[0]?.start && w[0]?.end) {
    const reason = deferralReason({ start: w[0].start.slice(0, 5), end: w[0].end.slice(0, 5) });
    blockedIf(!!reason, `"${PROFILE}" has a no-cut window and ${reason}, so a breach would correctly not ` +
      `suspend. Run again in Costa Rica daytime on a weekday.`);
  }
}

async function seedAccount(db: DbHelper, logger: TestLogger, tag: string, nise?: string, profile = PROFILE): Promise<Seeded> {
  const suffix = uniqueRunSuffix();
  const meter = `${METER_PREFIX}${suffix}`;
  const seed = new PrepaidSeedHelper(logger);
  const { accountId, orderId } = await seed.seed({
    meter, customerId: `${tag}-${suffix}`, name: `${tag} ${suffix}`,
    creditProfileName: profile, ...(nise ? { clientId: `${nise}-${suffix}` } : {}),
  });
  const rows = await poll(
    () => db.query<{ svc: string; sub: string; provid: string; meter: string; status: string }>(
      `SELECT su.id AS svc, su.subscriptionid AS sub, su.provisioningid AS provid,
              sp.provisioningid AS meter, su.status
         FROM core_engine.service_unit su
         JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
        WHERE su.accountid = $1`, [accountId]),
    r => r.length === 1 && r[0].status === 'ACTIVE', 120_000, 5_000);
  expect(rows.length, `seeded ${accountId} (${orderId}) has no ACTIVE metered service unit`).toBe(1);
  // Carry the meter that is ON service_provision, not the string we invented:
  // that row is what the engine dispatches, so it is what the guard must judge.
  expect(rows[0].meter, `${accountId}: service_provision holds ${rows[0].meter}, not the invented ${meter}`)
    .toBe(meter);
  const prof = await db.query<{ p: string }>(
    `SELECT creditprofilename AS p FROM core_engine.subscription WHERE id = $1`, [rows[0].sub]);
  expect(prof[0]?.p, `${accountId} did not get the ${profile} profile`).toBe(profile);
  console.log(`\n  seeded ${accountId} / ${orderId} / meter ${meter} / ${rows[0].svc}` +
    (nise ? ` / NISE (clientId) ${nise}-${suffix}` : ' / no NISE') + '\n');
  return { accountId, meter: rows[0].meter, svc: rows[0].svc, sub: rows[0].sub, provId: rows[0].provid };
}

/** Re-reads service_provision, so the check judges what really goes on the wire. */
async function assertSafeToDispatch(db: DbHelper, s: Seeded) {
  await assertMeterSafe(db, s, METER_PREFIX);
}

// ── reads ────────────────────────────────────────────────────────────────

async function balance(db: DbHelper, accountId: string): Promise<number> {
  const r = await db.query<{ amount: string }>(
    `SELECT bb.amount::text AS amount FROM core_engine.balance_unit bu
       JOIN core_engine.balance_unit_balances bb ON bb.id = bu.id
      WHERE bu.accountid = $1 AND bb.currencyid = 'CRC'`, [accountId]);
  return Number(r[0]?.amount ?? NaN);
}

/**
 * A6 fix (engine e5a26f9, 2026-10-07) behind countHeldUsageInCreditCheck: completing the SUSPEND no longer reconnects,
 * and only a top-up that covers what is owed does. The journeys were verified with it on; off, they are BLOCKED.
 */
async function heldUsageOn(db: DbHelper): Promise<boolean> {
  return db.isHeldUsageCountedInCreditCheck();
}

/** The charge kept on the meter's latest reading held for credit - null since JEPYP-482 (nothing is held any more). */
async function heldCharge(db: DbHelper, meter: string): Promise<number | null> {
  const r = await db.query<{ nv: string }>(
    `SELECT netvalue::text AS nv FROM core_usage.file_detail_record
      WHERE provisioningid = $1 AND errorcode = 'CURRENCY_CREDIT_LIMIT_EXCEEDED' AND netvalue IS NOT NULL
      ORDER BY enddate DESC NULLS LAST LIMIT 1`, [meter]);
  return r[0] ? Number(r[0].nv) : null;
}

async function accountState(db: DbHelper, s: Seeded) {
  const r = await db.query<{ sub: string; svc: string }>(
    `SELECT (SELECT status FROM core_engine.subscription WHERE id = $1) AS sub,
            (SELECT status FROM core_engine.service_unit WHERE id = $2) AS svc`, [s.sub, s.svc]);
  return r[0];
}

async function orders(db: DbHelper, accountId: string) {
  return db.query<{ id: string; type: string; status: string; userid: string; reason: string; partial: string }>(
    `SELECT id, type, status, userid, coalesce(subscriptionreason::text,'') AS reason,
            coalesce(ispartialfulfillmentallowed::text,'null') AS partial
       FROM core_oms."order" WHERE accountid = $1 ORDER BY id`, [accountId]);
}

/**
 * The newest order of a type on the account. `userid` narrows it when given.
 * The automatic RESUME is NOT always by jasec-dev: it carries whoever made the
 * top-up (jasec-dev from Selfcare, embrxadmin from the GraphQL top-up), so it is
 * matched on type and reason instead.
 */
async function autoOrder(db: DbHelper, accountId: string, type: 'SUSPEND' | 'RESUME', userid?: string) {
  const r = await db.query<{ id: string; status: string; reason: string; partial: string; userid: string }>(
    `SELECT id, status, userid, coalesce(subscriptionreason::text,'') AS reason,
            coalesce(ispartialfulfillmentallowed::text,'null') AS partial
       FROM core_oms."order" WHERE accountid = $1 AND type = $2 AND ($3::text IS NULL OR userid = $3)
      ORDER BY id DESC LIMIT 1`,
    [accountId, type, userid ?? null]);
  return r[0];
}

/**
 * One breach must raise ONE suspend. Measured 2026-09-28 (ACT-101082): a single
 * reading suspended twice on one service-usage thread, 1.6 s apart - once from
 * PGCreditLimitEvaluationService, once more after PGUsageRatingService caught the
 * CURRENCY_CREDIT_LIMIT_EXCEEDED - so ORD-1895 and ORD-1896 were both created and
 * both dispatched D in parallel. With a real meter the second is refused "Ya
 * existe una solicitud pendiente" and stays open for good.
 */
async function assertOneSuspend(db: DbHelper, accountId: string) {
  const r = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM core_oms."order"
      WHERE accountid = $1 AND type = 'SUSPEND' AND userid = 'CreditLimitBreach' ORDER BY id`, [accountId]);
  expect.soft(r.map(x => `${x.id} ${x.status}`),
    'one breach raised MORE THAN ONE automatic SUSPEND - both dispatch to the AMI, and the one that is not ' +
    'confirmed stays open').toHaveLength(1);
}

async function commands(db: DbHelper, order: string): Promise<Cmd[]> {
  return db.query<Cmd>(
    `SELECT id,
            coalesce(substring(request::text from '<accion>([A-Z])</accion>'),'') AS accion,
            coalesce(substring(request::text from '<medidor>([^<]+)'),'') AS medidor,
            coalesce(substring(response::text from 'DescripcionRespuesta>([^<]+)'),
                     substring(response::text from 'errorMsg": *"([^"]+)'), '') AS answer
       FROM core_engine.activity
      WHERE apiname ILIKE '%UTILITIES%' AND request::text LIKE $1 ORDER BY id`,
    [`%<numeroOrden>${order}</numeroOrden>%`]);
}

/** The row for the file just sent - not the meter's latest row, which may be an older reading. */
async function readingRecord(db: DbHelper, meter: string, file: string) {
  const r = await db.query<{ id: string; status: string; errorcode: string; errormsg: string }>(
    `SELECT id, status, coalesce(errorcode,'') AS errorcode, coalesce(left(errormsg,220),'') AS errormsg
       FROM core_usage.file_detail_record WHERE provisioningid = $1 AND id = $2`, [meter, file]);
  return r[0];
}

/** The MDR file name submitReading produced. */
function mdrFile(out: string): string {
  const file = out.match(/MDR_PREPAGO_[0-9-]+\.csv/)?.[0] ?? '';
  expect(file, 'submitReading did not report the file it produced').not.toBe('');
  return file;
}

/**
 * What the account does with energy while suspended / after resume - the part
 * that matters to JASEC, beyond the status fields. The physical cut is JASEC's;
 * what Embrix controls is whether a reading is CHARGED. Measured 2026-09-28:
 * suspended -> SUSPENDED / NO_ACTIVE_SERVICE_FOR_THE_PROVISIONING_ID, nothing
 * charged; active -> PROCESSED for the delta since the last RATED reading
 * (a refused reading never advances it, so its consumption is billed later).
 */
async function readingOutcome(db: DbHelper, mdr: MdrRemoteHelper, s: Seeded, reading: number) {
  const before = await balance(db, s.accountId);
  const out = await mdr.submitReading(s.meter, reading);
  const file = out.match(/MDR_PREPAGO_[0-9-]+\.csv/)?.[0] ?? '';
  const row = await poll(async () => {
    const r = await db.query<{ id: string; status: string; errorcode: string; qty: string; where: string }>(
      `SELECT id, status, coalesce(errorcode,'') AS errorcode, quantity::text AS qty, 'processed' AS where
         FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND id = $2
       UNION ALL
       SELECT id, status, coalesce(errorcode,'') AS errorcode, quantity::text AS qty, 'in-flight' AS where
         FROM core_usage.file_detail_record WHERE provisioningid = $1 AND id = $2 AND status <> 'PENDING'`,
      [s.meter, file]);
    return r[0];
  }, r => !!r, 180_000, 5_000);
  const after = await balance(db, s.accountId);
  console.log(`  reading ${reading} (${file}): ${row?.where} ${row?.status}/${row?.errorcode} qty=${row?.qty}; ` +
    `balance ${before} -> ${after}`);
  return { row, before, after, file };
}

async function notified(db: DbHelper, accountId: string, type: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM core_engine.email_notification WHERE accountid = $1 AND type = $2`,
    [accountId, type]);
  return Number(r[0]?.n ?? 0);
}

// ── actions ──────────────────────────────────────────────────────────────

/** Wait until the order's dispatch stops: 1 attempt + 3 retries, sequence FAILED. */
async function waitForDispatch(db: DbHelper, order: string, expectAccion: 'D' | 'C'): Promise<Cmd[]> {
  const cmds = await poll(async () => {
    const c = await commands(db, order);
    const st = await db.query<{ status: string }>(`SELECT status FROM core_oms."order" WHERE id = $1`, [order]);
    return { c, status: st[0]?.status ?? '' };
  }, v => (v.status === 'PROVISIONING_ERROR' && v.c.length >= 4) || v.c.some(x => /Registrada/i.test(x.answer)),
  240_000, 6_000);
  for (const c of cmds.c) console.log(`  ${c.id} ${order} accion=${c.accion} medidor=${c.medidor} -> ${c.answer}`);
  expect(cmds.c.some(x => /Registrada/i.test(x.answer)), 'JASEC ACCEPTED an invented meter - stop and tell the team')
    .toBe(false);
  expect(cmds.c.length, `${order}: no command reached the AMI`).toBeGreaterThan(0);
  for (const c of cmds.c) expect(c.accion, `${c.id}: wrong action on the wire`).toBe(expectAccion);
  expect.soft(cmds.c.length, `${order}: expected 1 attempt + 3 retries`).toBe(4);
  expect.soft(cmds.status, `${order} after its retries`).toBe('PROVISIONING_ERROR');
  return cmds.c;
}

async function callback(request: APIRequestContext, s: Seeded, order: string, type: 'SUSPEND' | 'RESUME') {
  const res = await request.post(CALLBACK_URL, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      accountId: s.accountId, orderType: type, orderId: order, status: 'COMPLETED',
      services: [{ serviceType: 'ELECTRICITY', action: type, bundleId: 'B-100000-E',
                   provisioningDataType: 'METER', provisioningId: s.provId }],
    },
    timeout: 120_000,
  });
  const body = await res.text();
  console.log(`  callback ${type} ${order}: HTTP ${res.status()} ${body.slice(0, 160)}`);
  expect(body, `${type} callback for ${order} was refused`).toContain('FINALIZADO');
}

/**
 * One CCP-clock day per status change (team, 2026-10-30). The service history (service_unit_aud) keeps the CCP DATE
 * only, so on a test build whose clock stays on one day the "created", "suspended" and "reconnected" records of an
 * account all carry the same 00:00. A reading picks the latest record before it, and with a tie the pick is random -
 * a reading while cut was then sometimes billed as if active (ACT-101255; N8 before the fix). Moving the clock one day
 * before the cut and one more before the reconnect makes the latest record unambiguous. Prod runs on the real clock
 * (real times, no tie) and its clock is never moved: there `next` does nothing. `restore` puts the start date back.
 */
function clockDays(logger: TestLogger) {
  const seed = new PrepaidSeedHelper(logger);
  let start = '';
  return {
    next: async (why: string) => {
      if (TENANT === 'jasec') return;
      const today = await seed.ccpDate();
      if (!start) start = today;
      const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
      const iso = d.toISOString().slice(0, 10);
      await seed.setCcpDate(iso);
      console.log(`  clock ${today} -> ${iso} (${why})`);
    },
    restore: async () => {
      if (!start || !CLOCK_RESTORE) return;
      if (CLOCK_RESTORE) await seed.setCcpDate(start).catch(e => console.log(`  WARNING: clock not restored to ${start}: ${e}`));
      if (CLOCK_RESTORE) console.log(`  clock restored to ${start}`);
    },
  };
}

/** Is the MDR file listed on Billing Hub > Usage > Suspended/Failed Batches (what the agent sees)? */
function listedOn(
  page: { navigateToHome(): Promise<unknown> },
  usage: { navigateViaNav(): Promise<void>; findSuspendedBatch(file: string): Promise<unknown> },
) {
  return async (file: string) => {
    await page.navigateToHome();
    await usage.navigateViaNav();
    return !!(await usage.findSuspendedBatch(file));
  };
}

async function note(testInfo: TestInfo, title: string, body: string) {
  console.log(`  OBSERVED - ${title}: ${body}`);
  testInfo.annotations.push({ type: 'observed', description: `${title}: ${body}` });
}

/** Steps 1-3 shared by every test: seed, fund, rate a small reading. */
async function fundedAccount(db: DbHelper, logger: TestLogger, tag: string, nise?: string, profile = PROFILE) {
  await preconditions(db);
  const mdr = new MdrRemoteHelper(logger);
  blockedIf(!(await mdr.isAvailable()),
    'the MDR loader tree is not reachable over SSH - cannot submit a reading. Check the VPN.');
  const s = await seedAccount(db, logger, tag, nise, profile);
  await assertSafeToDispatch(db, s);

  await test.step(`top up ${INITIAL_TOPUP} and rate a ${FIRST_READING} kWh reading`, async () => {
    await new PrepaidSeedHelper(logger).topUp(s.accountId, INITIAL_TOPUP);
    const b0 = await poll(() => balance(db, s.accountId), v => v === -INITIAL_TOPUP, 60_000, 3_000);
    expect(b0, 'a top-up is a NEGATIVE CRC balance (credit)').toBe(-INITIAL_TOPUP);
    // A fresh meter's FIRST reading is its baseline and rates 0 kWh by design
    // (confirmed by the team on JASEC prod, 2026-09-30), so send a 0 kWh one first.
    // Readings below are absolute and assume a 0 start; a declared start
    // (flexattr16) would make this baseline go backwards - BLOCK, do not guess.
    const declared = await db.getDeclaredStartReading(s.meter);
    blockedIf(declared !== 0, `${s.meter} has a declared start reading of ${declared} kWh; this case assumes 0.`);
    await mdr.submitReading(s.meter, declared);
    const baselined = await poll(async () => (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core_usage.file_detail_record_processed
        WHERE provisioningid = $1 AND status = 'PROCESSED'`, [s.meter]))[0].n,
      n => n > 0, 180_000, 5_000);
    expect(baselined, 'the 0 kWh baseline reading never processed').toBeGreaterThan(0);
    await mdr.submitReading(s.meter, FIRST_READING);
    const b1 = await poll(() => balance(db, s.accountId), v => v > -INITIAL_TOPUP, 180_000, 5_000);
    expect(b1, `the ${FIRST_READING} kWh reading never charged the balance`).toBeGreaterThan(-INITIAL_TOPUP);
    expect(b1, 'the first reading must stay inside the credit').toBeLessThan(0);
    console.log(`  balance after ${FIRST_READING} kWh: ${b1}`);
  });
  return { s, mdr };
}

/**
 * A reading over the balance (JEPYP-482, fixed on preprod + prod 2026-10-30): BILLED on its day - the balance goes into
 * debt by the full charge - instead of being held (SUSPENDED / CURRENCY_CREDIT_LIMIT_EXCEEDED, nothing charged) as before.
 * Asserts the reading is processed for the kWh since the last billed reading and the balance moved into debt.
 */
async function billedIntoDebt(db: DbHelper, mdr: MdrRemoteHelper, s: Seeded, reading: number, sinceKwh: number, label: string) {
  const r = await readingOutcome(db, mdr, s, reading);
  expect(r.row, `the ${reading} kWh reading never appeared`).toBeTruthy();
  const after = await poll(() => balance(db, s.accountId), v => v !== r.before, 60_000, 3_000);
  expect(r.row.errorcode, `${label}: the reading FAILED on order_clientid_fkey - the automatic SUSPEND could not be saved ` +
    '(NISE in account.clientId)').not.toMatch(/order_clientid_fkey/);
  expect(`${r.row.where} ${r.row.status}/${r.row.errorcode}`,
    `${label}: a reading the balance cannot fund is BILLED into debt on its day, not held (JEPYP-482)`).toBe('processed PROCESSED/');
  expect.soft(Number(r.row.qty), `${label}: billed for the kWh since the last billed reading (${sinceKwh})`).toBe(reading - sinceKwh);
  expect(after, `${label}: the balance must go into debt (JASEC sign: positive = owed)`).toBeGreaterThan(0);
  expect(after, `${label}: the reading must charge the balance`).toBeGreaterThan(r.before);
  return { ...r, after };
}

/** The Saldo Agotado / Servicio Suspendido "Monto minimo a recargar" of the newest mail of a type (null when none). */
async function mailMinimum(db: DbHelper, accountId: string, type: string): Promise<number | null> {
  const r = await db.query<{ m: string | null }>(
    `SELECT substring(regexp_replace(regexp_replace(regexp_replace(content, '<!--.*?-->', ' ', 'g'),
              '<[^>]+>', ' ', 'g'), '\\s+', ' ', 'g') from '(?i)nimo a recargar &#8353;\\s*([0-9.,]+)') AS m
       FROM core_engine.email_notification WHERE accountid = $1 AND type = $2 ORDER BY id DESC LIMIT 1`,
    [accountId, type]);
  const m = r[0]?.m;
  return m ? Number(m.replace(/\./g, '').replace(',', '.')) : null;  // 10.845,08 -> 10845.08
}

/** Minimum base: 971.70 (15 kWh) once the cycle has a top-up, else 2,915.10 (45 kWh) - team rule 2026-10-08. */
async function minimumBase(db: DbHelper, accountId: string): Promise<number> {
  const t = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM core_engine.subscription_topup WHERE accountid = $1`, [accountId]);
  return Number(t[0]?.n ?? 0) > 0 ? 971.70 : 2915.10;
}

/** Send the breach reading, assert it is billed into debt and the system raised a SUSPEND. */
async function breach(db: DbHelper, mdr: MdrRemoteHelper, s: Seeded, testInfo: TestInfo) {
  const debt = await billedIntoDebt(db, mdr, s, BREACH_READING, FIRST_READING, 'breach');
  const exhausted = await poll(() => mailMinimum(db, s.accountId, 'CREDIT_LIMIT_BREACH'), v => v !== null, 120_000, 6_000);
  const want = Math.round(((await minimumBase(db, s.accountId)) + debt.after) * 100) / 100;
  expect.soft(exhausted, `Saldo Agotado minimum = base + the debt ${debt.after} (JEPYP-482)`).toBeCloseTo(want, 2);

  const susp = await poll(() => autoOrder(db, s.accountId, 'SUSPEND', 'CreditLimitBreach'), o => !!o, 120_000, 5_000);
  expect(susp, 'the breach raised no CreditLimitBreach SUSPEND order').toBeTruthy();
  expect(susp.reason, `${susp.id} subscription reason`).toBe('CREDIT_LIMIT_EXCEEDED');
  expect.soft(susp.partial, `${susp.id} carries isPartialFulfillmentAllowed - it would never be closed`).not.toBe('true');
  console.log(`  automatic SUSPEND ${susp.id} (${susp.status})`);
  await sleep(10_000);   // let a duplicate, if any, land before counting
  await assertOneSuspend(db, s.accountId);
  expect.soft(await notified(db, s.accountId, 'CREDIT_LIMIT_BREACH'),
    'one breach must send exactly one CREDIT_LIMIT_BREACH notification').toBe(1);
  const acc = await accountState(db, s);
  await note(testInfo, 'account state right after the breach, before any callback',
    `subscription ${acc.sub}, service unit ${acc.svc}`);
  return susp.id;
}


// ── the no-cut window (stock profile) ────────────────────────────────────

const STOCK_PROFILE = 'Prepaid Energy Profile';
/** Fixed-date CR holidays only; movable ones (Semana Santa, Ley 9875 Monday shifts) are NOT here. */
const CR_FIXED_HOLIDAYS: Record<string, string> = {
  '01-01': 'Año Nuevo', '04-11': 'Juan Santamaría', '05-01': 'Día del Trabajo',
  '07-25': 'Anexión de Nicoya', '08-02': 'Virgen de los Ángeles', '08-15': 'Día de la Madre',
  '09-15': 'Independencia', '12-01': 'Abolición del Ejército', '12-25': 'Navidad',
};

function costaRica() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (k: string) => parts.find(p => p.type === k)?.value ?? '';
  const hhmm = `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, mmdd: `${g('month')}-${g('day')}`, weekday: g('weekday'), hhmm };
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Why a breach right now must be DEFERRED, or '' when it must suspend. */
function deferralReason(win: { start: string; end: string }): string {
  const cr = costaRica();
  const [t, s, e] = [toMin(cr.hhmm), toMin(win.start), toMin(win.end)];
  const inWindow = s < e ? t >= s && t < e : t >= s || t < e;
  if (inWindow) return `CR ${cr.weekday} ${cr.date} ${cr.hhmm} is inside the ${win.start}-${win.end} no-cut window`;
  if (cr.weekday === 'Sat' || cr.weekday === 'Sun') return `CR ${cr.weekday} ${cr.date} is a weekend`;
  if (CR_FIXED_HOLIDAYS[cr.mmdd]) return `CR ${cr.date} is ${CR_FIXED_HOLIDAYS[cr.mmdd]}, a public holiday`;
  return '';
}

/**
 * Breach -> SUSPEND -> callback -> reading while suspended -> top-up -> RESUME ->
 * callback -> reading after resume. Shared by @auto-journey (no NISE) and
 * @auto-nise (NISE in clientId). With `nise`, both automatic orders must carry no
 * clientid (engine 4f16ffb9f leaves a non-account clientId off system orders).
 */
async function fullJourney(
  db: DbHelper, mdr: MdrRemoteHelper, s: Seeded, request: APIRequestContext, testInfo: TestInfo,
  logger: TestLogger, nise: boolean, ui: AgentScreens, batchListed: (file: string) => Promise<boolean>,
  clock: ReturnType<typeof clockDays>,
) {
    // The A6 expectations below need the held-usage fix; off means the tenant is misconfigured, not a pass.
    blockedIf(!(await heldUsageOn(db)), 'countHeldUsageInCreditCheck is off - the A6 fix (live on dev, preprod and ' +
      'prod since 2026-10-08) is not active on this tenant, so the journey cannot be judged');
    let suspendOrder = '';
    await clock.next('the breach and the cut get their own day');
    await test.step('breach: the reading is billed into debt and a CreditLimitBreach SUSPEND is raised', async () => {
      suspendOrder = await breach(db, mdr, s, testInfo);
    });
    await test.step('the SUSPEND sends D, is refused 4 times, stops at PROVISIONING_ERROR', async () => {
      await waitForDispatch(db, suspendOrder, 'D');
      const acc = await accountState(db, s);
      await note(testInfo, 'account state after the refused dispatch, before the callback',
        `subscription ${acc.sub}, service unit ${acc.svc}`);
    });
    await test.step('Core UI: the agent sees the refused SUSPEND waiting on the account', async () => {
      const db1 = await autoOrder(db, s.accountId, 'SUSPEND', 'CreditLimitBreach');
      const sv = await ui.services(s.accountId);
      const shown = sv.incomplete.find(r => r.includes(suspendOrder));
      expect.soft(shown, `Services > In-complete Orders does not list the refused SUSPEND ${suspendOrder}`).toBeTruthy();
      expect.soft(shown ?? '', `In-complete Orders shows ${suspendOrder} with a status other than the database's`).toContain(db1?.status ?? 'PROVISIONING_ERROR');
      const sent = (await commands(db, suspendOrder)).length;
      expect.soft(await ui.customerActivityDispatches(suspendOrder), `Customer Activity must show every dispatch attempt (${sent} in the database)`).toBe(sent);
    });
    await test.step('JASEC suspend callback completes the order and suspends the account', async () => {
      await callback(request, s, suspendOrder, 'SUSPEND');
      const st = await poll(() => autoOrder(db, s.accountId, 'SUSPEND', 'CreditLimitBreach'),
        o => o?.status === 'COMPLETED', 60_000, 5_000);
      expect.soft(st?.status, `automatic SUSPEND ${suspendOrder} after an accepted callback`).toBe('COMPLETED');
      const acc = await poll(() => accountState(db, s), a => a.sub === 'SUSPENDED' && a.svc === 'SUSPENDED', 60_000, 5_000);
      expect.soft(acc.sub, 'subscription after the suspend callback').toBe('SUSPENDED');
      expect.soft(acc.svc, 'service unit after the suspend callback - an ACTIVE unit still delivers power').toBe('SUSPENDED');
      expect.soft(await notified(db, s.accountId, 'SUSPEND_SUBSCRIPTION'), 'SUSPEND_SUBSCRIPTION notification row')
        .toBeGreaterThan(0);
      // TC-83 (EPDP-416): the breach's "Saldo Agotado" mail is recorded too. Before the F8 fix (2026-10-15) this row
      // was rolled back with the bill (old defect 4.2); preprod 2026-10-22: every billed-into-debt account has one.
      expect.soft(await notified(db, s.accountId, 'CREDIT_LIMIT_BREACH'), 'TC-83: CREDIT_LIMIT_BREACH notification row')
        .toBeGreaterThan(0);
    });
    // TC-84 (EPDP-417) amount: "Servicio suspendido" asks the same minimum as "Saldo Agotado" (team P4 fix 2026-10-16):
    // base + what is owed; base 971.70 (15 kWh) after a top-up in the cycle, 2,915.10 (45 kWh) without one. Since
    // JEPYP-482 (2026-10-30) the breach reading is billed into debt, so what is owed is the balance alone - nothing is held.
    await test.step('TC-84: the Servicio suspendido minimum is base + the debt and equals Saldo Agotado', async () => {
      const suspended = await poll(() => mailMinimum(db, s.accountId, 'SUSPEND_SUBSCRIPTION'), v => v !== null, 120_000, 6_000);
      const exhausted = await mailMinimum(db, s.accountId, 'CREDIT_LIMIT_BREACH');
      const held = await heldCharge(db, s.meter);
      const bal = await balance(db, s.accountId);
      const base = await minimumBase(db, s.accountId);
      const expected = Math.round((base + bal) * 100) / 100;
      console.log(`  TC-84: Servicio suspendido ${suspended}, Saldo Agotado ${exhausted}; base ${base} + debt ${bal} = ${expected}`);
      expect.soft(held, 'nothing is held any more - the breach reading was billed (JEPYP-482)').toBeNull();
      expect.soft(suspended, 'Servicio suspendido shows a Monto minimo a recargar').not.toBeNull();
      expect.soft(suspended, 'Servicio suspendido minimum = Saldo Agotado minimum (team P4 fix 2026-10-16)').toBe(exhausted);
      expect.soft(suspended, `Servicio suspendido minimum = base ${base} + debt ${bal}`).toBeCloseTo(expected, 2);
    });
    await test.step('Core UI: the agent sees the account suspended by the system', async () => {
      const sv = await ui.services(s.accountId);
      expect.soft(sv.sub, 'Services screen: subscription status after the suspend callback').toBe('SUSPENDED');
      expect.soft(sv.incomplete.filter(r => r.includes(suspendOrder)), `${suspendOrder} is completed but still under In-complete Orders`).toEqual([]);
      const od = await ui.order(suspendOrder);
      expect.soft(od['Type'], `order detail ${suspendOrder}: Type`).toBe('SUSPEND');
      expect.soft(od['Status'], `order detail ${suspendOrder}: Status`).toBe('COMPLETED');
      expect.soft(od['User Id'], `order detail ${suspendOrder}: raised by the system on a breach, not by an agent`).toBe('CreditLimitBreach');
      // A6 (found 2026-10-06, fixed 2026-10-07 behind countHeldUsageInCreditCheck): completing the SUSPEND used to
      // raise a RESUME (TOPUP, embrxadmin) in the same second - no top-up, nothing paid, the customer back on.
      const early = await autoOrder(db, s.accountId, 'RESUME');
      expect(early, `A6 - ${early?.id} (${early?.reason}, by ${early?.userid}) was raised the moment the SUSPEND ` +
        `completed, with no top-up: the customer is reconnected while the debt is unpaid`).toBeUndefined();
      expect.soft(sv.incomplete.filter(r => /\bRESUME\b/.test(r)), 'Core UI In-complete Orders: no RESUME before a top-up')
        .toEqual([]);
    });
    let refusedFile = '';
    await test.step('a reading that arrives while SUSPENDED is refused, charges nothing, and waits on Suspended/Failed Batches', async () => {
      const r = await readingOutcome(db, mdr, s, WHILE_SUSPENDED_READING);
      refusedFile = r.file;
      expect(r.row, `the ${WHILE_SUSPENDED_READING} reading never appeared`).toBeTruthy();
      expect.soft(`${r.row.status}/${r.row.errorcode}`, 'a suspended service must not rate energy')
        .toBe('SUSPENDED/NO_ACTIVE_SERVICE_FOR_THE_PROVISIONING_ID');
      expect.soft(r.after, 'a reading on a suspended service must not change the balance').toBe(r.before);
      // JEPYP-482: the refused row names its account, so the next billed reading can close it (checked after the resume)
      const acc = await db.query<{ a: string }>(
        `SELECT coalesce(accountid,'') AS a FROM core_usage.file_detail_record WHERE provisioningid = $1 AND id = $2`, [s.meter, r.file]);
      expect.soft(acc[0]?.a, 'the refused reading carries its account (JEPYP-482)').toBe(s.accountId);
      expect.soft(await batchListed(r.file), `${r.file}: a refused reading is shown to the agent on Suspended/Failed Batches`).toBe(true);
    });
    await test.step('a top-up smaller than the debt does not reconnect', async () => {
      const before = await balance(db, s.accountId);
      const owed = before;                               // JASEC sign: > 0 means the balance is in debt (JEPYP-482)
      expect(owed, `the balance ${before} must still be in debt before this step`).toBeGreaterThan(0);
      const partial = Math.max(100, Math.floor(owed / 2));
      console.log(`  balance ${before}: owed ${owed.toFixed(2)} -> top up ${partial} (not enough)`);
      const suspendsBefore = (await orders(db, s.accountId)).filter(o => o.type === 'SUSPEND').map(o => o.id);
      await new PrepaidSeedHelper(logger).topUp(s.accountId, partial);
      await sleep(45_000);                               // give any (wrong) RESUME time to appear
      // O1 - RECORDED, not judged (open with the team): does the partial top-up raise ANOTHER breach SUSPEND?
      const extra = (await orders(db, s.accountId)).filter(o => o.type === 'SUSPEND' && !suspendsBefore.includes(o.id));
      if (extra.length) {
        await note(testInfo, 'O1 - a partial top-up on the cut account raised another SUSPEND',
          extra.map(o => `${o.id} ${o.status} by ${o.userid}`).join(', '));
      }
      const res = await autoOrder(db, s.accountId, 'RESUME');
      expect(res, `${res?.id} was raised by a ${partial} top-up that does not cover the debt ${owed} - the customer ` +
        `would be reconnected without paying`).toBeUndefined();
      const acc = await accountState(db, s);
      expect.soft(acc.sub, 'subscription after a top-up that does not cover the debt').toBe('SUSPENDED');
      const after = await balance(db, s.accountId);
      expect.soft(Math.round(after * 100) / 100, `the ${partial} top-up must reach the balance`).toBe(Math.round((before - partial) * 100) / 100);
      // What the agent sees: the top-up on Balances, the account still suspended, no RESUME waiting.
      expect.soft(await ui.crcBalance(s.accountId), 'Core UI Balances must show the partial top-up').toBe(Math.round(after * 100) / 100);
      const sv = await ui.services(s.accountId);
      expect.soft(sv.sub, 'Core UI Services: still SUSPENDED after a top-up that does not cover the debt').toBe('SUSPENDED');
      expect.soft(sv.incomplete.filter(r => /\bRESUME\b/.test(r)), 'Core UI In-complete Orders: no RESUME').toEqual([]);
    });
    let resumeOrder = '';
    await clock.next('the reconnect gets its own day');
    await test.step(`top-up ${RECOVERY_TOPUP} pays the debt first and raises an automatic RESUME that sends C`, async () => {
      const owed = await balance(db, s.accountId);
      await new PrepaidSeedHelper(logger).topUp(s.accountId, RECOVERY_TOPUP);
      const paid = await poll(() => balance(db, s.accountId), v => v !== owed, 60_000, 3_000);
      expect.soft(Math.round(paid * 100) / 100, `the top-up pays the debt ${owed} first; the rest is credit`)
        .toBe(Math.round((owed - RECOVERY_TOPUP) * 100) / 100);
      const res = await poll(() => autoOrder(db, s.accountId, 'RESUME'), o => !!o, 120_000, 5_000);
      const all = await orders(db, s.accountId);
      expect(res, `the top-up raised no automatic RESUME. Orders: ${all.map(o => `${o.id} ${o.type} ${o.status} ${o.userid}`).join(', ')}`)
        .toBeTruthy();
      resumeOrder = res.id;
      expect.soft(res.partial, `${res.id} carries isPartialFulfillmentAllowed - it would never be closed`).not.toBe('true');
      console.log(`  automatic RESUME ${res.id} (reason ${res.reason})`);
      await waitForDispatch(db, resumeOrder, 'C');
      const acc = await accountState(db, s);
      expect.soft(acc.svc, 'a refused RESUME dispatch must not reconnect the meter').toBe('SUSPENDED');
    });
    await test.step('JASEC resume callback completes the order and reactivates the account', async () => {
      await callback(request, s, resumeOrder, 'RESUME');
      const st = await poll(() => autoOrder(db, s.accountId, 'RESUME'), o => o?.status === 'COMPLETED', 60_000, 5_000);
      expect.soft(st?.status, `automatic RESUME ${resumeOrder} after an accepted callback`).toBe('COMPLETED');
      const acc = await poll(() => accountState(db, s), a => a.sub === 'ACTIVE' && a.svc === 'ACTIVE', 60_000, 5_000);
      expect.soft(acc.sub, 'subscription after the resume callback').toBe('ACTIVE');
      expect.soft(acc.svc, 'service unit after the resume callback').toBe('ACTIVE');
      expect.soft(await notified(db, s.accountId, 'RESUME_SUBSCRIPTION'), 'RESUME_SUBSCRIPTION notification row')
        .toBeGreaterThan(0);
      const open = (await orders(db, s.accountId)).filter(o => !['COMPLETED', 'CANCELLED'].includes(o.status));
      expect.soft(open.map(o => `${o.id} ${o.type} ${o.status} by ${o.userid}`),
        'no order may be left open at the end - an open order blocks the next manual order').toEqual([]);
    });
    await test.step('Core UI: the agent sees the account active again, nothing left open', async () => {
      const sv = await ui.services(s.accountId);
      expect.soft(sv.sub, 'Services screen: subscription status after the resume callback').toBe('ACTIVE');
      expect.soft(sv.incomplete, 'Services > In-complete Orders must be empty at the end').toEqual([]);
      const od = await ui.order(resumeOrder);
      expect.soft(od['Type'], `order detail ${resumeOrder}: Type`).toBe('RESUME');
      expect.soft(od['Status'], `order detail ${resumeOrder}: Status`).toBe('COMPLETED');
    });
    await test.step('after the resume, a reading rates again - only what is new since the billed breach reading', async () => {
      const r = await readingOutcome(db, mdr, s, AFTER_RESUME_READING);
      expect(r.row, `the ${AFTER_RESUME_READING} reading never appeared`).toBeTruthy();
      expect.soft(`${r.row.where} ${r.row.status}`, 'a resumed service must rate energy again').toBe('processed PROCESSED');
      expect.soft(Number(r.row.qty),
        `charged quantity must be the meter delta since the last BILLED reading (${BREACH_READING}, billed into debt); ` +
        `the refused ${WHILE_SUSPENDED_READING} never advanced it - nothing charged twice, nothing lost`)
        .toBe(AFTER_RESUME_READING - BREACH_READING);
      const after = await poll(() => balance(db, s.accountId), v => v !== r.before, 60_000, 3_000);
      expect.soft(after, 'the resumed reading must charge the balance (move it toward debt)').toBeGreaterThan(r.before);
    });
    await test.step(`the reading refused while cut (${WHILE_SUSPENDED_READING}) is closed by the billed ${AFTER_RESUME_READING} and leaves the screen`, async () => {
      const closed = await poll(() => db.query<{ status: string; ec: string; msg: string; inflight: number }>(
        `SELECT p.status, coalesce(p.errorcode,'') AS ec, coalesce(p.errormsg,'') AS msg,
                (SELECT count(*)::int FROM core_usage.file_detail_record f WHERE f.provisioningid = $1 AND f.id = $2) AS inflight
           FROM core_usage.file_detail_record_processed p WHERE p.provisioningid = $1 AND p.id = $2`, [s.meter, refusedFile]),
        r => r.length > 0 && r[0].inflight === 0, 120_000, 5_000);
      console.log(`  ${refusedFile}: ${closed[0] ? `${closed[0].status}/${closed[0].ec} "${closed[0].msg.slice(0, 100)}"` : 'still held'}`);
      expect.soft(closed[0]?.inflight, `${refusedFile} must leave the in-flight table once a later reading billed it (JEPYP-482)`).toBe(0);
      expect.soft(closed[0]?.ec, `${refusedFile} is kept as processed with the covering reason`).toBe('HELD_READING_COVERED');
      expect.soft(closed[0]?.msg ?? '', `${refusedFile} names the reading that billed it`).toMatch(/^Billed by the reading /);
      expect.soft(await batchListed(refusedFile), `${refusedFile} is still on Suspended/Failed Batches after it was closed`).toBe(false);
    });
  if (nise) {
    await test.step('the automatic orders of a NISE account carry no clientid', async () => {
      const r = await db.query<{ id: string; type: string; clientid: string }>(
        `SELECT id, type, coalesce(clientid,'') AS clientid FROM core_oms."order"
          WHERE accountid = $1 AND type IN ('SUSPEND','RESUME') ORDER BY id`, [s.accountId]);
      for (const o of r) {
        expect.soft(o.clientid, `${o.id} ${o.type} copied the NISE into order.clientid`).toBe('');
      }
      expect(r.length, 'no automatic SUSPEND/RESUME was found to check').toBeGreaterThan(0);
    });
  }
}

// ── F7: a failed order blocks the next automatic one (TC-132 / TC-133) ───

/** The customer pays again after a failed reconnect (TC-132). Small: by then the balance is well in credit. */
const TOP_UP_AGAIN = 500;
/** Statuses the engine's open-order check treats as closed (EP-5528). Anything else blocks the next automatic order. */
const CLOSED = ['COMPLETED', 'CANCELLED', 'FAILED'];
/** CANCEL ORDER on screen renames the order to `<id>-<timestamp>` (seen on prod 2026-10-08: ORD-386-2026-10-08_02-10-39-216). */
const renamedByCancel = (id: string) => /^ORD-\d+-\d{4}-/.test(id);

/** ccp replaceProvisioningErrorOrders - the switch behind the F7 fix (engine 5c5b901); undefined when unset. */
async function replaceSwitch(db: DbHelper): Promise<string | undefined> {
  const r = await db.query<{ v: string }>(
    `SELECT value AS v FROM core_config.ccp_properties WHERE property = 'replaceProvisioningErrorOrders'`);
  return r[0]?.v;
}

async function orderStatus(db: DbHelper, id: string): Promise<string> {
  const r = await db.query<{ status: string }>(`SELECT status FROM core_oms."order" WHERE id = $1`, [id]);
  return r[0]?.status ?? '';
}

/** The newest order of a type that is not in `known` (and not an order renamed by CANCEL ORDER). */
async function newest(db: DbHelper, accountId: string, type: 'SUSPEND' | 'RESUME', known: string[]) {
  const r = (await orders(db, accountId))
    .filter(o => o.type === type && !known.includes(o.id) && !renamedByCancel(o.id))
    .sort((a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
  return r[r.length - 1];
}

/**
 * Runs `act` (a top-up, or a breaching reading) while `stuck` sits in PROVISIONING_ERROR and waits up to 5 min - the
 * same window the retired F7 check (explore-05) gave its control - for the engine to try again: a NEW order of that type, or the stuck one
 * re-sent (more AMI commands for it). Either counts as "retried"; the fix's exact shape is the team's choice.
 */
async function retriedAfter(db: DbHelper, s: Seeded, type: 'SUSPEND' | 'RESUME', stuck: string, act: () => Promise<void>) {
  const known = (await orders(db, s.accountId)).filter(o => o.type === type).map(o => o.id);
  const sent = (await commands(db, stuck)).length;
  await act();
  const v = await poll(async () => ({
    fresh: await newest(db, s.accountId, type, known),
    sent: (await commands(db, stuck)).length,
  }), x => !!x.fresh || x.sent > sent, 300_000, 10_000);
  const acc = await accountState(db, s);
  const verdict = v.fresh
    ? `a new ${type} ${v.fresh.id} (${v.fresh.status}) was raised`
    : v.sent > sent
      ? `the stuck ${type} ${stuck} was re-sent (${v.sent - sent} more command(s))`
      : `NO new ${type} in 5 min and ${stuck} not re-sent - the only ${type} is ${stuck} (${await orderStatus(db, stuck)}); ` +
        `subscription ${acc.sub}, service unit ${acc.svc}; ccp replaceProvisioningErrorOrders=` +
        `${(await replaceSwitch(db)) ?? '<unset>'}`;
  console.log(`  [F7] ${verdict}`);
  return { retried: !!v.fresh || v.sent > sent, fresh: v.fresh?.id, verdict };
}

/**
 * Completes whatever the engine retried; when it did not retry (F7 still live), takes the agent's way out on screen:
 * Services > In-complete Orders > CANCEL ORDER on the stuck order, then `trigger` again (top-up / breaching reading),
 * which must raise a new order (verified by hand on prod 2026-10-08). Then JASEC's callback for it.
 */
async function finish(
  db: DbHelper, request: APIRequestContext, s: Seeded, ui: AgentScreens, testInfo: TestInfo,
  type: 'SUSPEND' | 'RESUME', stuck: string, retry: { retried: boolean; fresh?: string }, trigger: () => Promise<void>,
) {
  let target = retry.fresh ?? (retry.retried ? stuck : '');
  if (retry.fresh) await replacedAsPromised(db, ui, s, stuck, retry.fresh);
  if (!target) {
    await ui.cancelIncompleteOrder(s.accountId, stuck);
    const gone = await poll(() => db.query<{ id: string; status: string }>(
      `SELECT id, status FROM core_oms."order" WHERE accountid = $1 AND (id = $2 OR id LIKE $3)`,
      [s.accountId, stuck, `${stuck}-%`]), r => r.length === 1 && r[0].status === 'CANCELLED', 60_000, 5_000);
    expect(gone.map(r => `${r.id} ${r.status}`).join(', '), `CANCEL ORDER on screen did not cancel ${stuck}`).toMatch(/ CANCELLED$/);
    const known = (await orders(db, s.accountId)).filter(o => o.type === type).map(o => o.id);
    await trigger();
    const fresh = await poll(() => newest(db, s.accountId, type, known), o => !!o, 180_000, 5_000);
    expect(fresh, `after CANCEL ORDER on ${stuck} the next ${type === 'RESUME' ? 'top-up' : 'breach'} raised no ${type} - ` +
      `the agent's workaround does not work`).toBeTruthy();
    await note(testInfo, "agent's way out", `CANCEL ORDER on ${stuck} (now ${gone[0].id}) -> ${fresh!.id} raised`);
    target = fresh!.id;
  }
  if (target === stuck) {
    await poll(() => orderStatus(db, stuck), st => !['PROVISIONING_INITIATED', 'PROCESSING', 'SUBMITTED'].includes(st), 240_000, 6_000);
  } else {
    await waitForDispatch(db, target, type === 'SUSPEND' ? 'D' : 'C');
  }
  await callback(request, s, target, type);
  const st = await poll(() => orderStatus(db, target), x => x === 'COMPLETED', 60_000, 5_000);
  expect.soft(st, `${type} ${target} after an accepted callback`).toBe('COMPLETED');
}

/**
 * What the team's fix promises when it replaces a failed order (engine 5c5b901, ccp replaceProvisioningErrorOrders,
 * 2026-10-09): the old order is CANCELLED and renamed `<id>-<timestamp>` (as In-complete Orders > Cancel does), and
 * ONE Customer Activity row AUTO_ORDER_REPLACED_FAILED records it (entity = the old id, response replacedBy = the new
 * order, cancelledAs = the renamed id) - in the database and on the agent's Customer Activity screen.
 */
async function replacedAsPromised(db: DbHelper, ui: AgentScreens, s: Seeded, stuck: string, fresh: string) {
  const old = await poll(() => db.query<{ id: string; status: string }>(
    `SELECT id, status FROM core_oms."order" WHERE accountid = $1 AND (id = $2 OR id LIKE $3)`,
    [s.accountId, stuck, `${stuck}-%`]), r => r.length === 1 && r[0].status === 'CANCELLED', 60_000, 5_000);
  expect.soft(old.map(r => `${r.id} ${r.status}`).join(', '),
    `the failed ${stuck} must be CANCELLED and renamed ${stuck}-<timestamp> when ${fresh} replaces it`).toMatch(new RegExp(`^${stuck}-[^ ]+ CANCELLED$`));
  const rows = await db.query<{ id: string; response: string }>(
    `SELECT id, response::text AS response FROM core_engine.activity
      WHERE accountid = $1 AND apiname = 'AUTO_ORDER_REPLACED_FAILED' AND entityid = $2`, [s.accountId, stuck]);
  expect.soft(rows.length, `exactly one AUTO_ORDER_REPLACED_FAILED row for ${stuck}`).toBe(1);
  const resp = rows[0] ? JSON.parse(rows[0].response) : {};
  expect.soft(resp.replacedBy, `AUTO_ORDER_REPLACED_FAILED replacedBy`).toBe(fresh);
  expect.soft(resp.cancelledAs, `AUTO_ORDER_REPLACED_FAILED cancelledAs = the renamed id`).toBe(old[0]?.id);
  expect.soft(resp.status, `AUTO_ORDER_REPLACED_FAILED status`).toBe('CANCELLED');
  await ui.openAccount(s.accountId);
  expect.soft(await ui.customerActivityRows(stuck, 'AUTO_ORDER_REPLACED_FAILED'),
    `Customer Activity screen must show the AUTO_ORDER_REPLACED_FAILED row for ${stuck}`).toBe(1);
  console.log(`  [F7 fix] ${stuck} -> ${old[0]?.id} CANCELLED, replaced by ${fresh}; activity row ${rows[0]?.id ?? 'MISSING'}`);
}

/** End state, in the database and as the agent sees it: the expected status, no order left open. */
async function endsClean(db: DbHelper, s: Seeded, ui: AgentScreens, want: 'ACTIVE' | 'SUSPENDED') {
  await test.step(`Core UI: at the end the agent sees the account ${want}, nothing left open`, async () => {
    const open = (await orders(db, s.accountId)).filter(o => !CLOSED.includes(o.status));
    expect.soft(open.map(o => `${o.id} ${o.type} ${o.status} by ${o.userid}`),
      'no order may be left open - an open order blocks every later automatic order of its type (F7)').toEqual([]);
    const sv = await ui.services(s.accountId);
    expect.soft(sv.sub, 'Services screen: subscription status at the end').toBe(want);
    expect.soft(sv.incomplete, 'Services > In-complete Orders must be empty at the end').toEqual([]);
  });
}

// ── tests ────────────────────────────────────────────────────────────────

test.describe('JEPYP-27 - automatic suspend and resume (credit breach / top-up)', () => {
  test('breach -> automatic SUSPEND -> callback -> top-up -> automatic RESUME -> callback @auto-journey @tc-131', { tag: ['@tc-83', '@tc-84'] },
    async ({ request, page, usagePage }, testInfo) => {
      test.skip(!RUN, 'GATED: seeds, drops MDR files and dispatches to the live AMI. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(1_200_000);
      const logger = new TestLogger('auto-suspend-resume');
      const clock = clockDays(logger);
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const { s, mdr } = await fundedAccount(db, logger, 'QAAUTO');
        await fullJourney(db, mdr, s, request, testInfo, logger, false, new AgentScreens(page), listedOn(page, usagePage), clock);
      } finally {
        await clock.restore();
        await db.disconnect();
      }
    });

  test('an account with a NISE breaches, suspends and resumes like any other @auto-nise',
    async ({ request, page, usagePage }, testInfo) => {
      test.skip(!RUN, 'GATED: seeds, drops MDR files and dispatches to the live AMI. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(1_200_000);
      const logger = new TestLogger('auto-suspend-resume-nise');
      const clock = clockDays(logger);
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const { s, mdr } = await fundedAccount(db, logger, 'QAAUTONISE', 'QA-NISE');
        await fullJourney(db, mdr, s, request, testInfo, logger, true, new AgentScreens(page), listedOn(page, usagePage), clock);
      } finally {
        await clock.restore();
        await db.disconnect();
      }
    });

  test('top-up arrives before JASEC confirm the suspend (scenario doc TC40) @auto-race @tc-128',
    async ({ request, page }, testInfo) => {
      test.skip(!RUN, 'GATED: seeds, drops MDR files and dispatches to the live AMI. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(1_200_000);
      const logger = new TestLogger('auto-suspend-resume-race');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const { s, mdr } = await fundedAccount(db, logger, 'QAAUTORACE');
        const suspendOrder = await breach(db, mdr, s, testInfo);
        await waitForDispatch(db, suspendOrder, 'D');

        await test.step('top up while the SUSPEND is still waiting for its callback', async () => {
          await new PrepaidSeedHelper(logger).topUp(s.accountId, RECOVERY_TOPUP);
          await sleep(45_000);
          const all = await orders(db, s.accountId);
          await note(testInfo, 'orders after a top-up during an open SUSPEND',
            all.map(o => `${o.id} ${o.type} ${o.status} by ${o.userid}`).join('; '));
        });

        await test.step('the late suspend callback, then any RESUME it leads to', async () => {
          await callback(request, s, suspendOrder, 'SUSPEND');
          // EP-5480 in crm-gateway: completing a CREDIT_LIMIT_EXCEEDED SUSPEND on an account
          // that has been topped up meanwhile should raise the RESUME itself.
          const res = await poll(async () => {
            const r = await db.query<{ id: string; status: string; userid: string }>(
              `SELECT id, status, userid FROM core_oms."order"
                WHERE accountid = $1 AND type = 'RESUME' ORDER BY id DESC LIMIT 1`, [s.accountId]);
            return r[0];
          }, r => !!r, 150_000, 6_000);
          const all = await orders(db, s.accountId);
          await note(testInfo, 'orders after the late suspend callback',
            all.map(o => `${o.id} ${o.type} ${o.status} by ${o.userid}`).join('; '));
          expect(res, 'no RESUME was raised for a customer who topped up - they would stay cut off').toBeTruthy();
          if (res.status !== 'COMPLETED') {
            await waitForDispatch(db, res.id, 'C');
            await callback(request, s, res.id, 'RESUME');
          }
          const acc = await poll(() => accountState(db, s), a => a.sub === 'ACTIVE' && a.svc === 'ACTIVE', 90_000, 5_000);
          expect.soft(acc.sub, 'subscription at the end - the customer paid').toBe('ACTIVE');
          expect.soft(acc.svc, 'service unit at the end').toBe('ACTIVE');
          const open = (await orders(db, s.accountId)).filter(o => !['COMPLETED', 'CANCELLED'].includes(o.status));
          expect.soft(open.map(o => `${o.id} ${o.type} ${o.status}`),
            'no order may be left open - an open order blocks every later one').toEqual([]);
        });

        await test.step('Core UI: at the end the agent sees the account active, nothing left open', async () => {
          const sv = await new AgentScreens(page).services(s.accountId);
          expect.soft(sv.sub, 'Services screen: subscription status at the end').toBe('ACTIVE');
          expect.soft(sv.incomplete, 'Services > In-complete Orders must be empty at the end').toEqual([]);
        });
      } finally {
        await db.disconnect();
      }
    });
  /**
   * TC-132 (EPDP-516, official since 2026-10-08) - F7: a customer who pays after a failed reconnect is reconnected.
   *
   * The engine skips an automatic SUSPEND/RESUME/CANCEL while the account has another order of that type in any
   * status except FAILED/COMPLETED/CANCELLED (PGOrderUtilsService.processSubscriptionUpdateOrder, EP-5528), and
   * PROVISIONING_ERROR is not in that list. So once a RESUME fails at JASEC (here: the AMI refuses QA meters; in
   * production a comms error), every later top-up is skipped - the customer pays and stays cut off. Confirmed by the
   * team 2026-10-08 (High; prod log "There is already open RESUME order for the account so not creating it again").
   *
   * Built the production way: real breach -> CreditLimitBreach SUSPEND -> JASEC's suspend callback (the cut) ->
   * covering top-up -> automatic RESUME, which JASEC refuses (no callback). Then the customer pays again: a reconnect
   * MUST be attempted again - a new RESUME, or the stuck one re-sent. FIXED 2026-10-09 (engine 5c5b901, ccp replaceProvisioningErrorOrders=true; verified dev + preprod):
   * the new order replaces the failed one, which is CANCELLED and renamed, with one AUTO_ORDER_REPLACED_FAILED
   * Customer Activity row (checked in the database and on screen, replacedAsPromised).
   * Either way the test then gets the customer back on, so the account never stays blocked: with the fix it
   * completes the new reconnect; without it, it uses the agent's way out on screen (Services > In-complete Orders >
   * CANCEL ORDER, then one more top-up) - which also proves that workaround every run. Ends ACTIVE, nothing open.
   * With the fix it also proves (team release note 2026-10-13; added to EPDP-516 as checks 5-6):
   *   - the replacement REPEATS: JASEC refuses the replacement too, the next top-up replaces it again - a chain where
   *     every older RESUME is CANCELLED + renamed, one AUTO_ORDER_REPLACED_FAILED row per replacement (entity type
   *     ORDER in the database; the screen row names ORDER - the note says ORDEN), only the newest keeps its id
   *   - only the SAME type on the SAME account is touched: this account's earlier non-RESUME orders and other
   *     accounts' PROVISIONING_ERROR orders keep their id and status (a parallel session replacing its own failed
   *     orders on the same tenant would show here - read the list before calling it a defect)
   * The skip / manual-refusal side of the same fix is TC-134.
   */
  test('a customer who pays after a failed reconnect is reconnected (F7) @auto-stuck-resume @tc-132',
    async ({ request, page }, testInfo) => {
      test.skip(!RUN, 'GATED: seeds, drops MDR files and dispatches to the live AMI. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(2_700_000);
      const logger = new TestLogger('auto-suspend-resume-stuck-resume');
      const db = new DbHelper(logger);
      const ui = new AgentScreens(page);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const { s, mdr } = await fundedAccount(db, logger, 'QAAUTOF7R');
        const othersSql = `SELECT id, status FROM core_oms."order" WHERE accountid <> $1 AND status = 'PROVISIONING_ERROR' ORDER BY id`;
        const othersBefore = await db.query<{ id: string; status: string }>(othersSql, [s.accountId]);
        await test.step('breach -> automatic SUSPEND -> JASEC confirm the cut', async () => {
          const susp = await breach(db, mdr, s, testInfo);
          await waitForDispatch(db, susp, 'D');
          await callback(request, s, susp, 'SUSPEND');
          const acc = await poll(() => accountState(db, s), a => a.sub === 'SUSPENDED' && a.svc === 'SUSPENDED', 60_000, 5_000);
          blockedIf(acc.sub !== 'SUSPENDED', `${s.accountId} is ${acc.sub}/${acc.svc} after the suspend callback - no cut account to test`);
        });
        const notResume = async () => (await orders(db, s.accountId)).filter(o => o.type !== 'RESUME').map(o => `${o.id} ${o.type} ${o.status}`);
        const othersMine = await notResume();
        const stuck = await test.step(`the customer pays (${RECOVERY_TOPUP}): the automatic RESUME fails at JASEC`, async () => {
          await new PrepaidSeedHelper(logger).topUp(s.accountId, RECOVERY_TOPUP);
          const res = await poll(() => newest(db, s.accountId, 'RESUME', []), o => !!o, 120_000, 5_000);
          expect(res, 'the covering top-up raised no RESUME - the precondition of F7 (a RESUME to fail) was not built').toBeTruthy();
          await waitForDispatch(db, res!.id, 'C');
          const st = await orderStatus(db, res!.id);
          blockedIf(st !== 'PROVISIONING_ERROR', `the RESUME ${res!.id} ended ${st}, not PROVISIONING_ERROR - no stuck order ` +
            `(on a tenant whose AMI accepts the meter, F7 needs a real comms failure)`);
          return res!.id;
        });
        await test.step('Core UI: the agent sees the account still cut and the failed RESUME waiting', async () => {
          const sv = await ui.services(s.accountId);
          expect.soft(sv.sub, 'Services: subscription after the failed reconnect').toBe('SUSPENDED');
          const row = sv.incomplete.find(r => r.startsWith(`${stuck} `));
          expect.soft(row, `In-complete Orders does not list the failed RESUME ${stuck}`).toBeTruthy();
          expect.soft(row ?? '', `In-complete Orders: ${stuck} status`).toContain('PROVISIONING_ERROR');
        });
        const retry = await test.step(`the customer pays again (${TOP_UP_AGAIN}): a reconnect must be attempted again`, async () => {
          const r = await retriedAfter(db, s, 'RESUME', stuck, async () => {
            const before = await balance(db, s.accountId);
            await new PrepaidSeedHelper(logger).topUp(s.accountId, TOP_UP_AGAIN);
            const after = await poll(() => balance(db, s.accountId), v => v !== before, 120_000, 5_000);
            expect(after, `top-up ${TOP_UP_AGAIN} was not applied - harness problem`).toBeCloseTo(before - TOP_UP_AGAIN, 2);
          });
          await note(testInfo, 'F7 verdict', r.verdict);
          expect.soft(r.retried, `F7 - ${r.verdict}. The customer paid twice and stays cut off; the skip is only logged ` +
            `(EP-5528 open-order check counts PROVISIONING_ERROR as open). Fixed 2026-10-09 by engine 5c5b901 behind ccp replaceProvisioningErrorOrders=true - see the verdict for the switch value`).toBe(true);
          return r;
        });
        // With the fix: the replacement fails too, and the next top-up must replace IT - a chain stuck -> 2nd -> 3rd.
        // finish() then checks the last replacement (replacedAsPromised) and completes the newest RESUME.
        const chain = [stuck];
        let last = { stuck, retry };
        if (retry.fresh) {
          const second = retry.fresh;
          await test.step(`(F7 fix) ${stuck} replaced by ${second}; JASEC refuses ${second} too: the next top-up replaces it again`, async () => {
            await replacedAsPromised(db, ui, s, stuck, second);
            await waitForDispatch(db, second, 'C');
            const again = await retriedAfter(db, s, 'RESUME', second, async () => {
              await new PrepaidSeedHelper(logger).topUp(s.accountId, TOP_UP_AGAIN);
            });
            await note(testInfo, 'F7 chain', `${stuck} -> ${second} -> ${again.fresh ?? '(none)'}: ${again.verdict}`);
            expect(again.fresh, `no new RESUME replaced the failed ${second} - ${again.verdict}`).toBeTruthy();
            chain.push(second, again.fresh!);
            last = { stuck: second, retry: again };
          });
        }
        await test.step('the customer is reconnected (with the fix: the new attempt; without: the agent cancels the stuck order on screen)', async () => {
          await finish(db, request, s, ui, testInfo, 'RESUME', last.stuck, last.retry,
            async () => { await new PrepaidSeedHelper(logger).topUp(s.accountId, TOP_UP_AGAIN); });
          const acc = await poll(() => accountState(db, s), a => a.sub === 'ACTIVE' && a.svc === 'ACTIVE', 90_000, 5_000);
          expect.soft(`${acc.sub}/${acc.svc}`, 'subscription / service unit at the end - the customer paid').toBe('ACTIVE/ACTIVE');
        });
        if (chain.length > 1) {
          const newestId = chain[chain.length - 1];
          await test.step('(F7 fix) the chain: every older RESUME CANCELLED + renamed, one replacement row each, only the newest left', async () => {
            const rs = (await orders(db, s.accountId)).filter(o => o.type === 'RESUME');
            expect.soft(rs.filter(o => !renamedByCancel(o.id)).map(o => o.id), 'only the newest RESUME keeps its id').toEqual([newestId]);
            for (const id of chain.slice(0, -1)) {
              expect.soft(rs.filter(o => o.id.startsWith(`${id}-`) && o.status === 'CANCELLED').map(o => o.id),
                `${id} CANCELLED and renamed ${id}-<timestamp>`).toHaveLength(1);
            }
            const rep = await db.query<{ entitytype: string }>(
              `SELECT entitytype FROM core_engine.activity WHERE accountid = $1 AND apiname = 'AUTO_ORDER_REPLACED_FAILED'`, [s.accountId]);
            expect.soft(rep.length, 'one AUTO_ORDER_REPLACED_FAILED row per replacement').toBe(chain.length - 1);
            expect.soft([...new Set(rep.map(r => r.entitytype))], 'activity entitytype in the database').toEqual(['ORDER']);
            await ui.openAccount(s.accountId);
            // The release note says "Customer Activity (entity ORDEN)"; the database stores ORDER. Read what the agent sees.
            const shown = await ui.customerActivityTexts(chain[0], 'AUTO_ORDER_REPLACED_FAILED');
            await note(testInfo, 'Customer Activity replacement row as shown', shown.join(' | ') || '<none>');
            expect.soft(shown[0] ?? '', 'the replacement row names its entity (release note: ORDEN)').toMatch(/\bORDEN\b|\bORDER\b/);
          });
        }
        await test.step('only RESUME orders on this account changed: its other orders and other accounts\' failed orders untouched', async () => {
          // Every top-up adds a RENEW order (normal) - so judge only the orders that existed before: same id, same status.
          const now = await notResume();
          expect.soft(othersMine.filter(o => !now.includes(o)), `${s.accountId}: its earlier non-RESUME orders must keep id and status`).toEqual([]);
          const after = await db.query<{ id: string; status: string }>(othersSql, [s.accountId]);
          const touched = othersBefore.filter(o => !after.some(a => a.id === o.id && a.status === o.status));
          expect.soft(touched.map(o => `${o.id} ${o.status}`), 'other accounts\' PROVISIONING_ERROR orders must be untouched').toEqual([]);
        });
        await endsClean(db, s, ui, 'ACTIVE');
      } finally {
        await db.disconnect();
      }
    });

  /**
   * TC-133 (EPDP-517, official since 2026-10-08) - the F7 mirror: a customer out of credit is cut off even after an
   * earlier cut failed. Same open-order check: once a breach SUSPEND fails at JASEC (PROVISIONING_ERROR, no callback)
   * the meter is NOT cut, and every later breach is skipped - the customer keeps power, their readings are billed
   * into further debt (JEPYP-482; held before it), but the cut is never sent (team 2026-10-08: "also real"). The next breach MUST raise the cut again - a
   * new SUSPEND, or the stuck one re-sent. FIXED 2026-10-09 (engine 5c5b901, ccp replaceProvisioningErrorOrders=true; verified dev + preprod):
   * the new order replaces the failed one, which is CANCELLED and renamed, with one AUTO_ORDER_REPLACED_FAILED
   * Customer Activity row (checked in the database and on screen, replacedAsPromised). Then, as TC-132: with the fix
   * it completes the new cut; without it the agent cancels the stuck SUSPEND on screen and the next breach must cut.
   * Ends SUSPENDED (cut, as a customer out of credit should be), nothing open.
   */
  test('a customer out of credit is cut off even after an earlier cut failed (F7 mirror) @auto-stuck-suspend @tc-133',
    async ({ request, page }, testInfo) => {
      test.skip(!RUN, 'GATED: seeds, drops MDR files and dispatches to the live AMI. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(1_800_000);
      const logger = new TestLogger('auto-suspend-resume-stuck-suspend');
      const db = new DbHelper(logger);
      const ui = new AgentScreens(page);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const { s, mdr } = await fundedAccount(db, logger, 'QAAUTOF7S');
        const stuck = await test.step('breach: a SUSPEND is raised and JASEC refuses it (no callback - the meter is not cut)', async () => {
          const id = await breach(db, mdr, s, testInfo);
          await waitForDispatch(db, id, 'D');
          const st = await orderStatus(db, id);
          blockedIf(st !== 'PROVISIONING_ERROR', `the SUSPEND ${id} ended ${st}, not PROVISIONING_ERROR - no stuck order to test`);
          const acc = await accountState(db, s);
          await note(testInfo, 'state after the failed SUSPEND', `${id} PROVISIONING_ERROR; subscription ${acc.sub}, service unit ${acc.svc}`);
          return id;
        });
        await test.step('Core UI: the agent sees the failed SUSPEND waiting on the account', async () => {
          const sv = await ui.services(s.accountId);
          const row = sv.incomplete.find(r => r.startsWith(`${stuck} `));
          expect.soft(row, `In-complete Orders does not list the failed SUSPEND ${stuck}`).toBeTruthy();
          expect.soft(row ?? '', `In-complete Orders: ${stuck} status`).toContain('PROVISIONING_ERROR');
        });
        let reading = WHILE_SUSPENDED_READING;
        const retry = await test.step(`the next reading breaches again (${reading}): the cut must be attempted again`, async () => {
          const r = await retriedAfter(db, s, 'SUSPEND', stuck, async () => {
            const out = await readingOutcome(db, mdr, s, reading);
            expect(out.row, 'the second reading never appeared - harness problem').toBeTruthy();
            expect.soft(`${out.row.where} ${out.row.status}/${out.row.errorcode}`,
              'the meter was never cut, so the next reading is billed into further debt (JEPYP-482)').toBe('processed PROCESSED/');
          });
          await note(testInfo, 'F7 mirror verdict', r.verdict);
          expect.soft(r.retried, `F7 mirror - ${r.verdict}. The customer is out of credit and keeps power; the skip is ` +
            `only logged (EP-5528 open-order check counts PROVISIONING_ERROR as open). Fixed 2026-10-09 by engine 5c5b901 behind ccp replaceProvisioningErrorOrders=true - see the verdict for the switch value`).toBe(true);
          return r;
        });
        await test.step('the customer is cut (with the fix: the new attempt; without: the agent cancels the stuck order on screen)', async () => {
          await finish(db, request, s, ui, testInfo, 'SUSPEND', stuck, retry, async () => {
            reading += 10;
            await readingOutcome(db, mdr, s, reading);
          });
          const acc = await poll(() => accountState(db, s), a => a.sub === 'SUSPENDED' && a.svc === 'SUSPENDED', 90_000, 5_000);
          expect.soft(`${acc.sub}/${acc.svc}`, 'subscription / service unit at the end - the customer is out of credit').toBe('SUSPENDED/SUSPENDED');
        });
        await endsClean(db, s, ui, 'SUSPENDED');
      } finally {
        await db.disconnect();
      }
    });

  /**
   * TC-134 (EPDP-518, official since 2026-10-13) - no new order while another of its type is open or failed. The
   * other side of the F7 fix (engine 5c5b901, ccp replaceProvisioningErrorOrders; team release note 2026-10-13):
   *   - a top-up while a RESUME is still IN PROGRESS creates NO new RESUME and writes one AUTO_ORDER_SKIPPED
   *     Customer Activity row (status SKIPPED, openOrders and entity = the in-progress order, entity type ORDER)
   *   - once that RESUME has FAILED (PROVISIONING_ERROR), an agent cannot raise a RESUME by hand on top of it
   *     (createOrder / submit refused) - only the automatic trigger replaces it (that replacement is TC-132)
   * The release note says the entity reads ORDEN; the database and the screen show ORDER - both are accepted.
   * NOT covered (no way to produce them on demand - asked the team): automatic CANCEL orders, and "BILLING_ERROR
   * orders still block". Ends ACTIVE with nothing open (the failed RESUME is replaced and completed, as TC-132).
   *   $env:JASEC_AUTO_PROV_RUN='true'; npx playwright test --project=jasec-provisioning-orders auto-suspend-resume --grep "@tc-134"
   */
  test('no new order while another of its type is open or failed (skip, manual refusal) @auto-skip-and-refuse @tc-134',
    async ({ request, page }, testInfo) => {
      test.skip(!RUN, 'GATED: seeds, drops MDR files and dispatches to the live AMI. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(2_400_000);
      const logger = new TestLogger('auto-suspend-resume-skip-refuse');
      const db = new DbHelper(logger);
      const ui = new AgentScreens(page);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const sw = await replaceSwitch(db);
        blockedIf(sw !== 'true', `replaceProvisioningErrorOrders is '${sw ?? '<unset>'}' on ${TENANT} - the fix under test is off`);
        const { s, mdr } = await fundedAccount(db, logger, 'QAAUTOF7K');

        await test.step('breach -> automatic SUSPEND -> JASEC confirm the cut', async () => {
          const susp = await breach(db, mdr, s, testInfo);
          await waitForDispatch(db, susp, 'D');
          await callback(request, s, susp, 'SUSPEND');
          const acc = await poll(() => accountState(db, s), a => a.sub === 'SUSPENDED' && a.svc === 'SUSPENDED', 60_000, 5_000);
          blockedIf(acc.sub !== 'SUSPENDED', `${s.accountId} is ${acc.sub}/${acc.svc} after the suspend callback - no cut account to test`);
        });

        const first = await test.step(`top-up ${RECOVERY_TOPUP} raises a RESUME; a top-up while it is in progress is SKIPPED`, async () => {
          await new PrepaidSeedHelper(logger).topUp(s.accountId, RECOVERY_TOPUP);
          const res = await poll(() => newest(db, s.accountId, 'RESUME', []), o => !!o, 120_000, 3_000);
          expect(res, 'the covering top-up raised no RESUME').toBeTruthy();
          const st = await orderStatus(db, res!.id);
          blockedIf(CLOSED.includes(st) || st === 'PROVISIONING_ERROR',
            `${res!.id} was already ${st} when the second top-up was due - too late to test AUTO_ORDER_SKIPPED`);
          const known = (await orders(db, s.accountId)).filter(o => o.type === 'RESUME').map(o => o.id);
          await new PrepaidSeedHelper(logger).topUp(s.accountId, TOP_UP_AGAIN);
          const skip = await poll(() => db.query<{ entitytype: string; entityid: string; response: string }>(
            `SELECT entitytype, entityid, response::text AS response FROM core_engine.activity
              WHERE accountid = $1 AND apiname = 'AUTO_ORDER_SKIPPED' ORDER BY id`, [s.accountId]), r => r.length > 0, 120_000, 5_000);
          const extra = await newest(db, s.accountId, 'RESUME', known);
          expect.soft(extra?.id ?? 'none', `a top-up while ${res!.id} is in progress must NOT raise another RESUME`).toBe('none');
          expect.soft(skip.length, 'exactly one AUTO_ORDER_SKIPPED row').toBe(1);
          const resp = skip[0] ? JSON.parse(skip[0].response) : {};
          expect.soft(resp.status, 'AUTO_ORDER_SKIPPED status').toBe('SKIPPED');
          expect.soft(String(resp.openOrders ?? ''), 'AUTO_ORDER_SKIPPED openOrders names the in-progress RESUME').toContain(res!.id);
          expect.soft(skip[0]?.entityid, 'AUTO_ORDER_SKIPPED entity = the in-progress order').toBe(res!.id);
          expect.soft(skip[0]?.entitytype, 'AUTO_ORDER_SKIPPED entitytype in the database').toBe('ORDER');
          await note(testInfo, 'AUTO_ORDER_SKIPPED', resp.message ?? JSON.stringify(resp));
          return res!.id;
        });

        await test.step(`Core UI: Customer Activity shows the AUTO_ORDER_SKIPPED row for ${first}`, async () => {
          await ui.openAccount(s.accountId);
          // The release note says "Customer Activity (entity ORDEN)"; the database stores ORDER. Read what the agent sees.
          const shown = await ui.customerActivityTexts(first, 'AUTO_ORDER_SKIPPED');
          await note(testInfo, 'Customer Activity skip row as shown', shown.join(' | ') || '<none>');
          expect.soft(shown.length, `Customer Activity must show the AUTO_ORDER_SKIPPED row for ${first}`).toBe(1);
          expect.soft(shown[0] ?? '', 'the skip row names its entity (release note: ORDEN)').toMatch(/\bORDEN\b|\bORDER\b/);
        });

        await test.step(`${first} fails at JASEC (QA meter): PROVISIONING_ERROR, listed in In-complete Orders`, async () => {
          await waitForDispatch(db, first, 'C');
          const st = await poll(() => orderStatus(db, first), x => x === 'PROVISIONING_ERROR' || CLOSED.includes(x), 120_000, 5_000);
          blockedIf(st !== 'PROVISIONING_ERROR', `the RESUME ${first} ended ${st}, not PROVISIONING_ERROR - no failed order to test the manual refusal`);
          const sv = await ui.services(s.accountId);
          const row = sv.incomplete.find(r => r.startsWith(`${first} `));
          expect.soft(row ?? '', `In-complete Orders: ${first} status`).toContain('PROVISIONING_ERROR');
        });

        await test.step(`a MANUAL RESUME is refused while ${first} is PROVISIONING_ERROR`, async () => {
          const user = process.env.EMBRIX_USER ?? 'congeroadmin';
          const pass = process.env.EMBRIX_PASSWORD ?? '';
          blockedIf(!pass, 'EMBRIX_PASSWORD is not set - the manual order needs a sign-in');
          const txn = `https://service-transactional.${TENANT}.embrix.org/graphql`;
          const login = await (await request.post(txn, { headers: { 'Content-Type': 'application/json' },
            data: { query: `query { userLogin(input:{userName:${JSON.stringify(user)},password:${JSON.stringify(pass)}}){ token } }` } })).text();
          const token = login.match(/"token":"([^"]+)"/)?.[1] ?? '';
          blockedIf(!token, `sign-in returned no token: ${login.slice(0, 200)}`);
          const gql = async (q: string) => (await request.post(txn, { headers: { 'Content-Type': 'application/json',
            Authorization: `Bearer ${token}` }, data: { query: q }, timeout: 120_000 })).text();
          const created = await gql(`mutation { createOrder(input:{type: RESUME, accountId: "${s.accountId}", userId: "${user}", ` +
            `services:[{index:1, serviceType: ELECTRICITY, action: RESUME, provisioningId: "${s.provId}", bundleId: "B-100000-E"}]}){ id status } }`);
          const manual = created.match(/"id":"(ORD-[0-9]+)"/)?.[1] ?? '';
          const submitted = manual ? await gql(`mutation { updateOrderStatus(input:{ id:"${manual}", status: SUBMITTED, userId:"${user}" }){ id status } }`) : '';
          const refused = !manual || /"errors"/.test(submitted);
          await note(testInfo, 'manual RESUME while a failed RESUME is open',
            `createOrder -> ${created.slice(0, 220)}${manual ? ` | submit -> ${submitted.slice(0, 220)}` : ''}`);
          expect.soft(refused, `a manual RESUME must be refused while ${first} is open in PROVISIONING_ERROR`).toBe(true);
          if (manual) {   // never leave it open: an open RESUME would block the account's next automatic one
            await gql(`mutation { updateOrderStatus(input:{ id:"${manual}", status: CANCELLED, userId:"${user}" }){ id status } }`);
            const left = await orderStatus(db, manual);
            console.log(`  manual ${manual}: ${left} after cleanup`);
            expect.soft(CLOSED.includes(left) || left === '', `the manual ${manual} could not be closed (${left}) - cancel it on In-complete Orders`).toBe(true);
          }
        });

        await test.step(`the customer pays again (${TOP_UP_AGAIN}) and is reconnected (the failed ${first} is replaced, as TC-132)`, async () => {
          const retry = await retriedAfter(db, s, 'RESUME', first, async () => {
            await new PrepaidSeedHelper(logger).topUp(s.accountId, TOP_UP_AGAIN);
          });
          await finish(db, request, s, ui, testInfo, 'RESUME', first, retry,
            async () => { await new PrepaidSeedHelper(logger).topUp(s.accountId, TOP_UP_AGAIN); });
          const acc = await poll(() => accountState(db, s), a => a.sub === 'ACTIVE' && a.svc === 'ACTIVE', 90_000, 5_000);
          expect.soft(`${acc.sub}/${acc.svc}`, 'subscription / service unit at the end').toBe('ACTIVE/ACTIVE');
        });
        await endsClean(db, s, ui, 'ACTIVE');
      } finally {
        await db.disconnect();
      }
    });

  /**
   * EXPLORATORY - NOT AN OFFICIAL CASE YET (not in the official case list; deliberately no TC tag).
   *
   * A teammate's "gap test" (2026-10-07): the A6 fix covers the two reconnect checks that fire at once (cut
   * confirmed, top-up received). Does anything that runs LATER - the daily jobs, days after the cut - reconnect
   * an account whose unpaid reading is held? From the code, no: the only other RESUME source is the collection
   * reconnect, which acts on subscriptions suspended for COLLECTIONS (postpaid), and CREDIT_LIMIT_ACTIONS only
   * suspends. This proves it by moving the clock 8+ days and running the operator's daily chain (Daily Schedule
   * screen, every job of the DAILY template).
   *
   * It also RECORDS, without judging (open finding A8), whether that daily run suspends an account whose reading
   * was held overnight inside the no-cut window and never cut: CREDIT_LIMIT_ACTIONS selects by balance only, so
   * today it should not. Give that account in JASEC_HELD_ACTIVE_ACCOUNT (dev: ACT-101220).
   *
   * MUTATING: moves the tenant clock, runs the DAILY chain on that date (bills whoever is due - dev).
   *   $env:JASEC_AUTO_PROV_RUN='true'; $env:JASEC_HELD_CYCLE_RUN='true'; npx playwright test --project=jasec-provisioning-orders auto-suspend-resume --grep "@auto-held-cycle"
   */
  test('a cut account still in debt stays cut through a daily run days later @auto-held-cycle',
    async ({ request, page, dailySchedulePage }, testInfo) => {
      // Its OWN gate: JASEC_AUTO_PROV_RUN alone runs every test here, and this one also moves the clock and runs
      // the whole DAILY chain - which bills every account due that date, whoever owns it.
      test.skip(!RUN || process.env.JASEC_HELD_CYCLE_RUN !== 'true',
        'GATED: moves the clock and runs the DAILY chain. Set JASEC_AUTO_PROV_RUN=true AND JASEC_HELD_CYCLE_RUN=true.');
      test.skip(TENANT === 'jasec-preprod',
        'BLOCKED, not failed: the DAILY chain bills every account due on the run date - preprod is own-data only. Run on jasec-dev.');
      test.setTimeout(2_400_000);
      const logger = new TestLogger('auto-suspend-resume-held-cycle');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      const seed = new PrepaidSeedHelper(logger);
      const startClock = await seed.ccpDate();
      try {
        const { s, mdr } = await fundedAccount(db, logger, 'QAHELDCYC');
        const suspendOrder = await breach(db, mdr, s, testInfo);
        await waitForDispatch(db, suspendOrder, 'D');
        await callback(request, s, suspendOrder, 'SUSPEND');
        const cut = await poll(() => accountState(db, s), a => a.sub === 'SUSPENDED', 60_000, 5_000);
        expect(cut.sub, 'the breach SUSPEND did not take').toBe('SUSPENDED');
        const held = await balance(db, s.accountId);   // the unpaid amount: the debt (JEPYP-482), no held reading any more
        expect(held, 'the breach reading must leave the account in debt').toBeGreaterThan(0);
        expect(await autoOrder(db, s.accountId, 'RESUME'), 'a RESUME already exists before the daily run (A6)').toBeUndefined();
        console.log(`  ${s.accountId} cut by ${suspendOrder}, debt ${held}`);

        const other = (process.env.JASEC_HELD_ACTIVE_ACCOUNT ?? '').trim();
        const otherBefore = other ? (await db.query<{ status: string }>(
          `SELECT status FROM core_engine.subscription WHERE accountid = $1 ORDER BY id LIMIT 1`, [other]))[0]?.status : undefined;

        // The first date 8+ days on that is usable: free, or (test tenants) its used schedule is reclaimed - the Daily
        // Schedule screen would open an existing one instead. Only a PROCESSING run is skipped (schedule-slot.helper).
        let runDate = '';
        for (let d = 8; d <= 60 && !runDate; d++) {
          const cand = new Date(`${startClock}T00:00:00Z`); cand.setUTCDate(cand.getUTCDate() + d);
          const iso = cand.toISOString().slice(0, 10);
          if (await dateUsable(db, iso)) runDate = iso;    // free, or reclaimable on dev / preprod (schedule-slot.helper)
        }
        if (blockedIf(!runDate, `no usable schedule date between ${startClock} +8 and +60 days (taken, and not reclaimable here)`)) return;
        const freed = await ensureDateFree(db, runDate);
        if (blockedIf(!freed.free, `${freed.reason}`)) return;

        await test.step(`the operator's daily chain runs on ${runDate}`, async () => {
          await seed.setCcpDate(runDate);
          const chain = await dailySchedulePage.createAndProcess(runDate, () => seed.setCcpDate(runDate).then(() => undefined), logger);
          console.log(`  Daily Schedule ${runDate}: ${Object.entries(chain).map(([k, v]) => `${k}=${v}`).join(' ') || '(none parsed)'}`);
          await note(testInfo, `daily chain on ${runDate}`, Object.entries(chain).map(([k, v]) => `${k}=${v}`).join(' '));
          await sleep(30_000);                           // give any (wrong) RESUME time to appear
        });

        await test.step('the unpaid debt still keeps the account cut', async () => {
          const res = await autoOrder(db, s.accountId, 'RESUME');
          const all = await orders(db, s.accountId);
          expect(res, `${res?.id} (${res?.reason}, by ${res?.userid}) reconnected ${s.accountId} during the daily run - ` +
            `no top-up, the debt ${held} unpaid. Orders: ${all.map(o => `${o.id} ${o.type} ${o.status} ${o.userid}`).join(', ')}`)
            .toBeUndefined();
          const acc = await accountState(db, s);
          expect(acc.sub, 'subscription after the daily run').toBe('SUSPENDED');
          expect.soft(acc.svc, 'service unit after the daily run').toBe('SUSPENDED');
          const sv = await new AgentScreens(page).services(s.accountId);
          expect.soft(sv.sub, 'Core UI Services after the daily run').toBe('SUSPENDED');
        });

        if (other) {
          await test.step(`RECORD (A8): did the daily run cut the overnight-held account ${other}?`, async () => {
            const after = await db.query<{ status: string }>(
              `SELECT status FROM core_engine.subscription WHERE accountid = $1 ORDER BY id LIMIT 1`, [other]);
            const susp = await autoOrder(db, other, 'SUSPEND');
            await note(testInfo, `A8 - overnight-held account ${other} after the daily run`,
              `subscription ${otherBefore} -> ${after[0]?.status}; automatic SUSPEND: ${susp ? `${susp.id} ${susp.status}` : 'none'}`);
          });
        }
      } finally {
        if (CLOCK_RESTORE) await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
        await db.disconnect();
      }
    });

  /**
   * The stock profile's no-cut rule, judged against REAL Costa Rica time (the
   * CCP clock has no time of day, so it cannot be simulated). The test picks its
   * expectation from the clock at run time:
   *
   *   inside 20:00-08:00 CR, a weekend or a fixed-date holiday
   *       -> the reading is billed into debt with Saldo Agotado, NO SUSPEND is raised, the account stays ACTIVE;
   *          the next reading over the limit is billed too and sends Saldo Agotado again with the new amount
   *   an ordinary CR weekday 08:00-20:00
   *       -> the reading is billed into debt and a CreditLimitBreach SUSPEND is raised
   * (JEPYP-482, 2026-10-30: before it the reading parked and charged nothing.)
   *
   * It prints the account id. Checking that same account again after the window
   * ends answers scenario doc TC41 ("accounts that ran out overnight are suspended
   * when the window ends"). It does NOT happen: finding A8, confirmed on dev
   * 2026-10-07 by @auto-held-cycle - the balance never moved (the reading is held),
   * and the daily CREDIT_LIMIT_ACTIONS selects accounts by balance only.
   */
  test('the stock profile defers a breach inside the no-cut window and suspends outside it @auto-window @tc-129',
    async ({ page }, testInfo) => {
      test.skip(!RUN, 'GATED: seeds, drops MDR files and may dispatch to the live AMI. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(900_000);
      const logger = new TestLogger('auto-suspend-resume-window');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const w = await db.query<{ start: string; end: string }>(
          `SELECT a.exceptionstarttime::text AS start, a.exceptionendtime::text AS end
             FROM core_config.credit_profile cp
             JOIN core_config.credit_profile_limit_actions a ON a.id = cp.id
            WHERE cp.name = $1 AND a.action = 'SUBSCRIPTION_SUSPENSION'`, [STOCK_PROFILE]);
        blockedIf(!w.length || !w[0].start || !w[0].end,
          `"${STOCK_PROFILE}" has no SUBSCRIPTION_SUSPENSION window on ${TENANT}, so there is no rule to test.`);
        const win = { start: w[0].start.slice(0, 5), end: w[0].end.slice(0, 5) };
        const deferred = deferralReason(win);
        const cr = costaRica();
        // A run that crosses a boundary would test half of each rule. Keep 25 min clear.
        const edge = [win.start, win.end].map(x => (toMin(x) - toMin(cr.hhmm) + 1440) % 1440).find(m => m < 25);
        blockedIf(edge !== undefined,
          `CR is ${cr.hhmm}, ${edge} min from a window boundary (${win.start}/${win.end}). The run would cross it; re-run later.`);
        console.log(`\n  ${deferred ? 'EXPECT DEFERRAL - ' + deferred : `EXPECT SUSPENSION - CR ${cr.weekday} ${cr.date} ${cr.hhmm} is an ordinary weekday outside ${win.start}-${win.end}`}\n`);

        const { s, mdr } = await fundedAccount(db, logger, deferred ? 'QAWINDOWIN' : 'QAWINDOWOUT', undefined, STOCK_PROFILE);
        await note(testInfo, 'account for the morning-after (scenario doc TC41) check', `${s.accountId} meter ${s.meter}`);

        if (!deferred) {
          let suspendOrder = '';
          await test.step('outside the window: the breach suspends', async () => {
            suspendOrder = await breach(db, mdr, s, testInfo);
          });
          // TC-129 on the agent's screens (2026-10-06): the SUSPEND the breach raised is visible, and it
          // was raised by the system (User Id CreditLimitBreach), not by an agent.
          await test.step('Core UI: the agent sees the SUSPEND the breach raised', async () => {
            const ui = new AgentScreens(page);
            const sv = await ui.services(s.accountId);
            const o = await autoOrder(db, s.accountId, 'SUSPEND', 'CreditLimitBreach');
            const shownRow = sv.incomplete.find(r => r.includes(suspendOrder));
            if (o?.status === 'COMPLETED') {
              expect.soft(shownRow, `${suspendOrder} is COMPLETED but still under In-complete Orders`).toBeUndefined();
            } else {
              expect.soft(shownRow, `Services > In-complete Orders does not show the SUSPEND ${suspendOrder} (${o?.status})`).toBeTruthy();
            }
            const od = await ui.order(suspendOrder);
            expect.soft(od['Type'], `order detail ${suspendOrder}: Type`).toBe('SUSPEND');
            expect.soft(od['Status'], `order detail ${suspendOrder}: Status must equal the database`).toBe(o?.status ?? '');
            expect.soft(od['User Id'], `order detail ${suspendOrder}: raised by the system on a breach`).toBe('CreditLimitBreach');
          });
          return;
        }

        await test.step('inside the window: the reading is billed into debt with Saldo Agotado, but nothing is suspended', async () => {
          const debt = await billedIntoDebt(db, mdr, s, BREACH_READING, FIRST_READING, 'inside the window');
          const first = await poll(() => mailMinimum(db, s.accountId, 'CREDIT_LIMIT_BREACH'), v => v !== null, 120_000, 6_000);
          const base = await minimumBase(db, s.accountId);
          expect.soft(first, `Saldo Agotado minimum = base ${base} + debt ${debt.after}`).toBeCloseTo(Math.round((base + debt.after) * 100) / 100, 2);
          await sleep(60_000);   // give any (wrong) SUSPEND time to appear
          const all = await orders(db, s.accountId);
          const susp = all.filter(o => o.type === 'SUSPEND');
          expect(susp.map(o => `${o.id} ${o.status} by ${o.userid}`),
            `${deferred}: a breach must NOT raise a SUSPEND now`).toEqual([]);
          const acc = await accountState(db, s);
          expect(acc.sub, 'the subscription must stay ACTIVE inside the window').toBe('ACTIVE');
          expect(acc.svc, 'the service unit must stay ACTIVE inside the window').toBe('ACTIVE');
          const n = await db.query<{ type: string; status: string }>(
            `SELECT type, status FROM core_engine.email_notification WHERE accountid = $1 ORDER BY createddate, id`,
            [s.accountId]);
          await note(testInfo, 'notifications after a deferred breach', n.map(x => `${x.type}/${x.status}`).join(', ') || 'none');

          // Each further reading over the limit at night is billed too and sends Saldo Agotado again (team, JEPYP-482).
          const again = await billedIntoDebt(db, mdr, s, BREACH_READING + 10, BREACH_READING, 'second reading inside the window');
          const mails = await poll(() => notified(db, s.accountId, 'CREDIT_LIMIT_BREACH'), v => v >= 2, 120_000, 6_000);
          const second = await mailMinimum(db, s.accountId, 'CREDIT_LIMIT_BREACH');
          expect.soft(mails, 'every reading over the limit sends Saldo Agotado again').toBe(2);
          expect.soft(second, `the second Saldo Agotado asks base ${base} + the new debt ${again.after}`)
            .toBeCloseTo(Math.round((base + again.after) * 100) / 100, 2);
          await sleep(30_000);
          expect((await orders(db, s.accountId)).filter(o => o.type === 'SUSPEND').map(o => o.id),
            `${deferred}: the second reading must not raise a SUSPEND either`).toEqual([]);

          // TC-129 on the agent's screen (2026-10-06): inside the window the agent must see the account
          // ACTIVE with no SUSPEND waiting - the customer keeps power overnight.
          const sv = await new AgentScreens(page).services(s.accountId);
          expect(sv.sub, 'Core UI Services: the subscription must show ACTIVE inside the window').toBe('ACTIVE');
          expect(sv.incomplete.filter(r => /\bSUSPEND\b/.test(r)), 'Core UI In-complete Orders: no SUSPEND inside the window')
            .toEqual([]);
          console.log(`\n  For the morning half: ${s.accountId} is in debt and not cut. After ${win.end} CR on a weekday run ` +
            `@window-morning (next reading cuts) or @window-daily (the Daily Schedule cuts) with JASEC_MORNING_ACCOUNT=${s.accountId}.\n`);
        });
      } finally {
        await db.disconnect();
      }
    });

  /**
   * TC-129, the MORNING half (2026-10-15): an account whose breach was held overnight inside the no-cut window is cut
   * by its NEXT reading once the window has ended. The team's F8 release note (2026-10-15): "outside those hours it
   * waits for the next meter reading in allowed hours or the CREDIT_LIMIT_ACTIONS job of a later Daily Schedule".
   * Proven by hand on prod 2026-10-15 (ACT-100383: night breach CR 02:44, daytime reading CR 08:58 -> SUSPEND ORD-807).
   * The other path (a later Daily's CREDIT_LIMIT_ACTIONS, A8 fixed 2026-10-16) is TC-130 (@window-daily).
   *
   * Two sessions: run @tc-129 at Costa Rica NIGHT (its inside half prints the account), then this one in Costa Rica
   * weekday DAYTIME with that account:
   *   $env:JASEC_AUTO_PROV_RUN='true'; $env:JASEC_MORNING_ACCOUNT='<ACT-...>'
   *   npx playwright test --project=jasec-provisioning-orders auto-suspend-resume --grep "@window-morning"
   */
  test('a breach held overnight is cut by the next reading after the window ends @window-morning @tc-129',
    async ({}, testInfo) => {
      test.skip(!RUN, 'GATED: drops an MDR file and may dispatch to the live AMI. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(600_000);
      const accountId = (process.env.JASEC_MORNING_ACCOUNT ?? '').trim();
      blockedIf(!accountId, 'set JASEC_MORNING_ACCOUNT to the account the @tc-129 inside half seeded at Costa Rica night.');
      const logger = new TestLogger('auto-suspend-resume-morning');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const w = await db.query<{ start: string; end: string }>(
          `SELECT a.exceptionstarttime::text AS start, a.exceptionendtime::text AS end
             FROM core_config.credit_profile cp
             JOIN core_config.credit_profile_limit_actions a ON a.id = cp.id
            WHERE cp.name = $1 AND a.action = 'SUBSCRIPTION_SUSPENSION'`, [STOCK_PROFILE]);
        blockedIf(!w.length, `"${STOCK_PROFILE}" has no SUBSCRIPTION_SUSPENSION window on ${TENANT}.`);
        const deferred = deferralReason({ start: w[0].start.slice(0, 5), end: w[0].end.slice(0, 5) });
        blockedIf(!!deferred, `the morning half needs Costa Rica weekday daytime: ${deferred}`);

        const r = await db.query<{ svc: string; sub: string; provid: string; meter: string }>(
          `SELECT su.id AS svc, su.subscriptionid AS sub, su.provisioningid AS provid, sp.provisioningid AS meter
             FROM core_engine.service_unit su JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
            WHERE su.accountid = $1`, [accountId]);
        blockedIf(r.length !== 1, `${accountId} has ${r.length} metered service units, expected 1.`);
        const s: Seeded = { accountId, meter: r[0].meter, svc: r[0].svc, sub: r[0].sub, provId: r[0].provid };
        blockedIf(!s.meter.startsWith(METER_PREFIX), `${accountId}'s meter ${s.meter} was not invented by this spec.`);
        await assertSafeToDispatch(db, s);

        // The precondition: over the limit overnight (in debt since JEPYP-482; a held reading on an older account), nothing cut yet.
        const owed = await balance(db, accountId);
        const last = await db.query<{ q: string }>(
          `SELECT max(kwhinboundtotal)::text AS q FROM core_mediation.energy_cdr_detail WHERE meterdeviceid = $1 AND status = 'MOVED_TO_FDR'`, [s.meter]);
        blockedIf(!(owed > 0) || !last[0]?.q, `${accountId} is not in debt (balance ${owed}) - run the @tc-129 inside half at night first.`);
        blockedIf(!!(await autoOrder(db, accountId, 'SUSPEND', 'CreditLimitBreach')),
          `${accountId} already has a CreditLimitBreach SUSPEND - it was cut before this run (A8 fixed?), nothing left to prove here.`);
        const acc0 = await accountState(db, s);
        expect(acc0.sub, `${accountId} must still be ACTIVE after the night (the breach was deferred)`).toBe('ACTIVE');
        // The clock may have been left anywhere since the night half: date the morning reading after the account's own.
        await clockPastAccount(db, new PrepaidSeedHelper(logger), accountId);

        await test.step('the next reading in daytime cuts', async () => {
          const next = Number(last[0].q) + 20;
          const mdr = new MdrRemoteHelper(logger);
          blockedIf(!(await mdr.isAvailable()), 'the MDR loader tree is not reachable over SSH - cannot submit a reading.');
          const file = mdrFile(await mdr.submitReading(s.meter, next));
          const rec = await poll(async () => (await readingRecord(db, s.meter, file)) ?? ((await db.query<{ id: string }>(
            `SELECT id FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND id = $2`, [s.meter, file]))[0]
            ? { id: file, status: 'PROCESSED', errorcode: '', errormsg: '' } : undefined), x => !!x && x.status !== 'PENDING', 180_000, 5_000);
          const done = await db.query<{ status: string; ec: string }>(
            `SELECT status, coalesce(errorcode,'') AS ec FROM core_usage.file_detail_record_processed WHERE provisioningid = $1 AND id = $2`, [s.meter, file]);
          console.log(`  morning reading ${next}: ${done[0] ? `processed ${done[0].status}` : `in-flight ${rec?.status}/${rec?.errorcode}`}`);
          expect(done[0] ? `processed ${done[0].status}/${done[0].ec}` : `${rec?.status}/${rec?.errorcode}`,
            'the morning reading is billed into further debt (JEPYP-482)').toBe('processed PROCESSED/');
          const susp = await poll(() => autoOrder(db, accountId, 'SUSPEND', 'CreditLimitBreach'), o => !!o, 120_000, 5_000);
          expect(susp, 'the morning reading raised no CreditLimitBreach SUSPEND - the overnight customer is never cut').toBeTruthy();
          expect(susp.reason, `${susp.id} subscription reason`).toBe('CREDIT_LIMIT_EXCEEDED');
          await sleep(10_000);
          await assertOneSuspend(db, accountId);
          await note(testInfo, 'morning cut', `${accountId}: reading ${next} -> SUSPEND ${susp.id} (${susp.status})`);
        });
      } finally {
        await db.disconnect();
      }
    });

  /**
   * TC-130 (official since 2026-10-16) - A8 fix (team, 2026-10-16): CREDIT_LIMIT_ACTIONS judges what the account owes (the amount the reconnect
   * check uses). An ACTIVE account over the limit (in debt since JEPYP-482) gets a SUSPEND (CreditLimitBreach) from the next
   * Daily Schedule run, Mon-Fri 08:00-20:00 Costa Rica time, not on holidays - with NO new reading. Before the fix the job
   * selected on balance alone and never cut these (preprod ACT-100517, prod ACT-100383, dev ACT-101220).
   *
   * Two sessions, like @window-morning: the @tc-129 inside half at CR night leaves a held, uncut account; then this one
   * in CR weekday daytime runs a DAILY (on the first usable date after the clock, reclaimed if used) and expects exactly one cut.
   * MUTATING: moves the clock and runs the DAILY chain, which bills / cuts every account due or over its limit
   * that day - own-data guard; JASEC_DAILY_ALLOW lists foreign accounts Anh approved for this run.
   *   $env:JASEC_AUTO_PROV_RUN='true'; $env:JASEC_MORNING_ACCOUNT='<ACT-...>'
   *   npx playwright test --project=jasec-provisioning-orders auto-suspend-resume --grep "@window-daily"
   */
  test('a breach held overnight is cut by the next Daily Schedule after the window ends @window-daily @tc-130',
    async ({ dailySchedulePage }, testInfo) => {
      test.skip(!RUN, 'GATED: moves the clock and runs the DAILY chain. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(1_800_000);   // + the 10-min prod clock settle before the DAILY
      const accountId = (process.env.JASEC_MORNING_ACCOUNT ?? '').trim();
      blockedIf(!accountId, 'set JASEC_MORNING_ACCOUNT to an account the @tc-129 inside half left held and uncut at Costa Rica night.');
      const allow = (process.env.JASEC_DAILY_ALLOW ?? '').split(',').map(x => x.trim()).filter(Boolean);
      const logger = new TestLogger('auto-suspend-resume-window-daily');
      const db = new DbHelper(logger);
      const seed = new PrepaidSeedHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      const startClock = await seed.ccpDate();
      try {
        const w = await db.query<{ start: string; end: string }>(
          `SELECT a.exceptionstarttime::text AS start, a.exceptionendtime::text AS end
             FROM core_config.credit_profile cp
             JOIN core_config.credit_profile_limit_actions a ON a.id = cp.id
            WHERE cp.name = $1 AND a.action = 'SUBSCRIPTION_SUSPENSION'`, [STOCK_PROFILE]);
        blockedIf(!w.length, `"${STOCK_PROFILE}" has no SUBSCRIPTION_SUSPENSION window on ${TENANT}.`);
        const deferred = deferralReason({ start: w[0].start.slice(0, 5), end: w[0].end.slice(0, 5) });
        blockedIf(!!deferred, `the cut by the Daily Schedule needs Costa Rica weekday daytime: ${deferred}`);

        // Precondition: over the limit and uncut (a reading would have cut it already - that is @window-morning). Since
        // JEPYP-482 that is a debt on the balance; older night accounts have a held reading instead.
        const debt = await balance(db, accountId);
        const held = await db.query<{ n: number }>(
          `SELECT count(*)::int n FROM core_usage.file_detail_record f
             JOIN core_engine.service_provision sp ON sp.provisioningid = f.provisioningid AND sp.type = 'METER'
             JOIN core_engine.service_unit su ON su.id = sp.id
            WHERE su.accountid = $1 AND f.status = 'SUSPENDED' AND f.errorcode = 'CURRENCY_CREDIT_LIMIT_EXCEEDED'`, [accountId]);
        blockedIf(!held[0]?.n && !(debt > 0), `${accountId} is not in debt and has no held reading - run the @tc-129 inside half at night first.`);
        blockedIf(!!(await autoOrder(db, accountId, 'SUSPEND', 'CreditLimitBreach')),
          `${accountId} already has a CreditLimitBreach SUSPEND - use a fresh night account.`);
        const sub0 = (await db.query<{ status: string }>(
          `SELECT status FROM core_engine.subscription WHERE accountid = $1 ORDER BY id LIMIT 1`, [accountId]))[0]?.status;
        blockedIf(sub0 !== 'ACTIVE', `${accountId} is ${sub0}, not ACTIVE.`);

        // The first usable date after the clock (free, or reclaimed on test tenants). On prod it must also touch only our
        // accounts (and allowed ones).
        const ours = `(coalesce((SELECT string_agg(sp.provisioningid, ',') FROM core_engine.service_unit su
                         JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
                        WHERE su.accountid = a.id), '') LIKE 'M-QA%' OR a.customerid ~* '^(E2E|QA)')`;
        const overLimit = (await db.query<{ id: string }>(
          `SELECT DISTINCT a.id FROM core_engine."subscription" s JOIN core_engine.account a ON a.id = s.accountid
             JOIN core_config.credit_profile c ON c.name = s.creditprofilename
             JOIN core_config.credit_profiles cp ON cp.id = c.id AND cp.currency = a.currency
             JOIN core_engine.balance_unit_balances bub ON bub.id = s.balanceunitid
            WHERE s.status = 'ACTIVE' AND NOT ${ours}
              AND (bub.amount > cp.creditlimit OR EXISTS (SELECT 1 FROM core_usage.file_detail_record f
                     JOIN core_engine.service_provision sp ON sp.provisioningid = f.provisioningid AND sp.type = 'METER'
                     JOIN core_engine.service_unit su ON su.id = sp.id
                    WHERE su.accountid = a.id AND f.status = 'SUSPENDED' AND f.errorcode = 'CURRENCY_CREDIT_LIMIT_EXCEEDED'))`))
          .map(r => r.id).filter(id => !allow.includes(id));
        // dev / preprod: cutting other accounts is fine (Anh 2026-10-20) - logged only; the real-device check
        // (blockIfAcceptedMeterAtRisk) runs at Process. prod keeps the own-data block, like ts-04 and ts-11.
        const others = `${overLimit.slice(0, 10).join(', ')}${overLimit.length > 10 ? ` (+${overLimit.length - 10})` : ''}`;
        if (overLimit.length && TENANT !== 'jasec') console.log(`  the DAILY will also cut accounts that are not ours (allowed): ${others}`);
        blockedIf(TENANT === 'jasec' && overLimit.length > 0, `a DAILY would cut accounts that are not ours (over the limit, or with a held reading): ${others}`);
        let runDate = '';
        // Count from the later of the clock and the account's own latest date: the clock may have been left before
        // the night account's breach, and a DAILY dated before it would judge nothing.
        const accLatest = await accountLatestDate(db, accountId);
        const base = accLatest > startClock ? accLatest : startClock;
        for (let d = 1; d <= 60 && !runDate; d++) {
          const iso = addDays(base, d);
          if (!(await dateUsable(db, iso))) continue;     // free, or reclaimable on dev / preprod (schedule-slot.helper)
          const due = (await db.query<{ id: string }>(
            `SELECT DISTINCT a.id FROM core_engine.billing_profile bp
               JOIN core_engine.bill_unit bu ON bu.accountid = bp.accountid AND bu.status = 'PENDING'
               JOIN core_engine.account a ON a.id = bp.accountid
              WHERE bp.nextaccountingdate <= $1::date - core_engine.get_future_cycle_date(bp.accountid) AND a.status = 'ACTIVE'
                AND NOT ${ours}`, [iso])).map(r => r.id).filter(id => !allow.includes(id));
          // Foreign accounts due that day are billed too: fine on dev / preprod (Anh 2026-10-20), refused on prod.
          if (!due.length || TENANT !== 'jasec') runDate = iso;
          if (due.length && TENANT !== 'jasec' && runDate === iso) console.log(`  the DAILY on ${iso} also bills accounts that are not ours (allowed): ${due.slice(0, 10).join(', ')}${due.length > 10 ? ` (+${due.length - 10})` : ''}`);
        }
        blockedIf(!runDate, TENANT === 'jasec'
          ? `no free date in 60 days after ${startClock} whose DAILY touches only our accounts - set JASEC_DAILY_ALLOW`
          : `no usable date in 60 days after ${startClock} (taken, and not reclaimable here)`);
        if (allow.length) console.log(`  own-data guard: Anh approved touching ${allow.join(', ')} for this run`);
        if (runDate) {
          const freed = await ensureDateFree(db, runDate);
          blockedIf(!freed.free, `${freed.reason}`);
        }

        await test.step(`the Daily Schedule on ${runDate} (CR daytime, no new reading) cuts ${accountId}`, async () => {
          await seed.setCcpDate(runDate);
          // prod: the Daily Schedule screen keeps the old date for minutes after a clock move and Process stays disabled
          // (prod build 3, 2026-10-16: this DAILY never ran - Process disabled, then the date picker timed out). Settle first.
          if ((process.env.TEST_ENV ?? '') === 'jasec') {
            console.log(`  prod: settling 10 min on ${runDate} before the Daily Schedule screen`);
            await sleep(600_000);
            await seed.setCcpDate(runDate);
          }
          const chain = await dailySchedulePage.createAndProcess(runDate, () => seed.setCcpDate(runDate).then(() => undefined), logger);
          console.log(`  Daily Schedule ${runDate}: ${Object.entries(chain).map(([k, v]) => `${k}=${v}`).join(' ') || '(none parsed)'}`);
          expect.soft(chain['CREDIT_LIMIT_ACTIONS'], 'CREDIT_LIMIT_ACTIONS card').toBe('COMPLETED');
          const susp = await poll(() => autoOrder(db, accountId, 'SUSPEND', 'CreditLimitBreach'), o => !!o, 180_000, 6_000);
          expect(susp, `the DAILY on ${runDate} raised no CreditLimitBreach SUSPEND for ${accountId} - a held overnight ` +
            `breach is still not cut by CREDIT_LIMIT_ACTIONS (A8)`).toBeTruthy();
          // Raised by THIS run: an order carries the CCP date it was created on (ids are not one sequence - preprod has OR-119966).
          const made = (await db.query<{ d: string }>(
            `SELECT createddate::date::text AS d FROM core_oms."order" WHERE id = $1`, [susp.id]))[0]?.d;
          expect(made, `${susp.id} must be raised by the DAILY on ${runDate}`).toBe(runDate);
          expect(susp.reason, `${susp.id} subscription reason`).toBe('CREDIT_LIMIT_EXCEEDED');
          await sleep(10_000);
          await assertOneSuspend(db, accountId);
          await note(testInfo, 'daily cut', `${accountId}: DAILY ${runDate} -> SUSPEND ${susp.id} (${susp.status})`);
        });
      } finally {
        if (CLOCK_RESTORE) await seed.setCcpDate(startClock).catch(e => console.log(`  WARNING: clock not restored to ${startClock}: ${e}`));
        if (CLOCK_RESTORE) console.log(`  clock restored to ${startClock}`);
        await db.disconnect();
      }
    });
});
