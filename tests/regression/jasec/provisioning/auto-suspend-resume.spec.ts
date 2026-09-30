/**
 * JEPYP-27, the AUTOMATIC path: balance runs out -> the system raises a SUSPEND
 * -> JASEC cut the meter -> top-up -> the system raises a RESUME -> JASEC
 * reconnect. This is what production does most, and until 2026-09-28 nothing
 * exercised it with provisioning switched on: ts-06 test B was written when
 * provisioningEnabled was absent on dev, so a breach suspended for billing only
 * and no order ever reached the AMI.
 *
 * THREE TESTS, run one tag at a time (each is several minutes):
 *
 *   @auto-journey   clean account (no NISE): breach -> CreditLimitBreach SUSPEND
 *                   -> 4 refused D commands -> callback -> top-up -> automatic
 *                   RESUME -> 4 refused C commands -> callback. Asserts both
 *                   orders COMPLETED and the account back to ACTIVE.
 *   @auto-nise      the same breach on an account shaped like the Create Account
 *                   screen makes it (NISE in clientId). FAILS while the
 *                   order_clientid_fkey defect is open: the reading FAILS instead
 *                   of parking and no SUSPEND is created.
 *   @auto-race      TC40: the customer tops up BEFORE JASEC's suspend callback.
 *                   Exploratory - asserts only the end state (account ACTIVE, no
 *                   order left open) and prints the order timeline.
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
 * GATED - reaches JASEC's live AMI and drops MDR files through the loader:
 *
 *   $env:JASEC_AUTO_PROV_RUN='true'
 *   npx playwright test --project=jasec-provisioning auto-suspend-resume --grep "@auto-journey"
 *
 * Needs VPN, the DB, and SSH to the control server (MDR loader).
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import type { APIRequestContext, TestInfo } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { MdrRemoteHelper } from '../../../../helpers/mdr-remote.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';
import { assertSafeToDispatch as assertMeterSafe } from '../../../../helpers/provisioning-safety.helper';

const RUN = process.env.JASEC_AUTO_PROV_RUN === 'true';
const TENANT = (process.env.TEST_ENV ?? 'jasec-dev').trim();
// Still dev + preprod only - this spec drives real suspend/resume commands to the AMI. It used to THROW on any other
// tenant, which on JASEC prod (2026-09-30) took down the whole jasec-provisioning
// project at load (0 tests listed). Now it SKIPS every test with a BLOCKED reason:
// just as fail-closed, without breaking the sibling specs.
const TENANT_REFUSED = !/^jasec-(dev|preprod)$/.test(TENANT);
test.skip(() => TENANT_REFUSED,
  `BLOCKED, not failed: this spec drives real suspend/resume commands to the AMI and runs on jasec-dev / jasec-preprod only ` +
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function poll<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 180_000, gap = 6_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let v = await read();
  while (!done(v) && Date.now() < until) { await sleep(gap); v = await read(); }
  return v;
}

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
    `throwCreditLimitBreachException is '${p.throwCreditLimitBreachException}': the tenant is no longer on ` +
    `Option A (park the reading), and this spec's expectations are Option A's. Re-derive them first.`);
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
 * (a parked reading never advances it, so parked consumption is recovered).
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
    await mdr.submitReading(s.meter, FIRST_READING);
    const b1 = await poll(() => balance(db, s.accountId), v => v > -INITIAL_TOPUP, 180_000, 5_000);
    expect(b1, `the ${FIRST_READING} kWh reading never charged the balance`).toBeGreaterThan(-INITIAL_TOPUP);
    expect(b1, 'the first reading must stay inside the credit').toBeLessThan(0);
    console.log(`  balance after ${FIRST_READING} kWh: ${b1}`);
  });
  return { s, mdr };
}

/** Send the breach reading, assert it parked and the system raised a SUSPEND. */
async function breach(db: DbHelper, mdr: MdrRemoteHelper, s: Seeded, testInfo: TestInfo) {
  const before = await balance(db, s.accountId);
  const file = mdrFile(await mdr.submitReading(s.meter, BREACH_READING));
  const rec = await poll(() => readingRecord(db, s.meter, file), r => !!r && r.status !== 'PENDING', 180_000, 5_000);
  console.log(`  breach reading: ${rec?.id} ${rec?.status}/${rec?.errorcode} ${rec?.errormsg.replace(/\s+/g, ' ')}`);
  expect(rec, 'the breach reading never appeared in file_detail_record').toBeTruthy();
  expect(rec.errormsg, 'the breach reading FAILED on order_clientid_fkey: the automatic SUSPEND could not be saved ' +
    '(NISE in account.clientId). No suspension, nothing charged, nothing parked.').not.toMatch(/order_clientid_fkey/);
  expect(`${rec.status}/${rec.errorcode}`, 'a reading the balance cannot fund must PARK (Option A)')
    .toBe('SUSPENDED/CURRENCY_CREDIT_LIMIT_EXCEEDED');
  expect(await balance(db, s.accountId), 'a parked reading must charge nothing').toBe(before);

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
  logger: TestLogger, nise: boolean,
) {
    let suspendOrder = '';
    await test.step('breach: the reading parks and a CreditLimitBreach SUSPEND is raised', async () => {
      suspendOrder = await breach(db, mdr, s, testInfo);
    });
    await test.step('the SUSPEND sends D, is refused 4 times, stops at PROVISIONING_ERROR', async () => {
      await waitForDispatch(db, suspendOrder, 'D');
      const acc = await accountState(db, s);
      await note(testInfo, 'account state after the refused dispatch, before the callback',
        `subscription ${acc.sub}, service unit ${acc.svc}`);
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
    });
    await test.step('a reading that arrives while SUSPENDED is refused and charges nothing', async () => {
      const r = await readingOutcome(db, mdr, s, WHILE_SUSPENDED_READING);
      expect(r.row, `the ${WHILE_SUSPENDED_READING} reading never appeared`).toBeTruthy();
      expect.soft(`${r.row.status}/${r.row.errorcode}`, 'a suspended service must not rate energy')
        .toBe('SUSPENDED/NO_ACTIVE_SERVICE_FOR_THE_PROVISIONING_ID');
      expect.soft(r.after, 'a reading on a suspended service must not change the balance').toBe(r.before);
    });
    let resumeOrder = '';
    await test.step(`top-up ${RECOVERY_TOPUP} raises an automatic RESUME that sends C`, async () => {
      await new PrepaidSeedHelper(logger).topUp(s.accountId, RECOVERY_TOPUP);
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
    await test.step('after the resume, a reading rates again - for everything since the last rated one', async () => {
      const r = await readingOutcome(db, mdr, s, AFTER_RESUME_READING);
      expect(r.row, `the ${AFTER_RESUME_READING} reading never appeared`).toBeTruthy();
      expect.soft(`${r.row.where} ${r.row.status}`, 'a resumed service must rate energy again').toBe('processed PROCESSED');
      expect.soft(Number(r.row.qty),
        `charged quantity must be the meter delta since the last RATED reading (${FIRST_READING}); the parked ` +
        `${BREACH_READING} and the refused ${WHILE_SUSPENDED_READING} never advanced it`)
        .toBe(AFTER_RESUME_READING - FIRST_READING);
      expect.soft(r.after, 'the resumed reading must charge the balance (move it toward debt)').toBeGreaterThan(r.before);
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

// ── tests ────────────────────────────────────────────────────────────────

test.describe('JEPYP-27 - automatic suspend and resume (credit breach / top-up)', () => {
  test('breach -> automatic SUSPEND -> callback -> top-up -> automatic RESUME -> callback @auto-journey',
    async ({ request }, testInfo) => {
      test.skip(!RUN, 'GATED: seeds, drops MDR files and dispatches to the live AMI. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(1_200_000);
      const logger = new TestLogger('auto-suspend-resume');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const { s, mdr } = await fundedAccount(db, logger, 'QAAUTO');
        await fullJourney(db, mdr, s, request, testInfo, logger, false);
      } finally {
        await db.disconnect();
      }
    });

  test('an account with a NISE breaches, suspends and resumes like any other @auto-nise',
    async ({ request }, testInfo) => {
      test.skip(!RUN, 'GATED: seeds, drops MDR files and dispatches to the live AMI. Set JASEC_AUTO_PROV_RUN=true.');
      test.setTimeout(1_200_000);
      const logger = new TestLogger('auto-suspend-resume-nise');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      try {
        const { s, mdr } = await fundedAccount(db, logger, 'QAAUTONISE', 'QA-NISE');
        await fullJourney(db, mdr, s, request, testInfo, logger, true);
      } finally {
        await db.disconnect();
      }
    });

  test('top-up arrives before JASEC confirm the suspend (TC40) @auto-race',
    async ({ request }, testInfo) => {
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
      } finally {
        await db.disconnect();
      }
    });
  /**
   * The stock profile's no-cut rule, judged against REAL Costa Rica time (the
   * CCP clock has no time of day, so it cannot be simulated). The test picks its
   * expectation from the clock at run time:
   *
   *   inside 20:00-08:00 CR, a weekend or a fixed-date holiday
   *       -> the reading parks, NO SUSPEND is raised, the account stays ACTIVE
   *   an ordinary CR weekday 08:00-20:00
   *       -> the reading parks and a CreditLimitBreach SUSPEND is raised
   *
   * It prints the account id. Checking that same account again after 08:00 CR
   * answers TC41 ("accounts that ran out overnight are suspended when the
   * window ends"), which our notes suggest does NOT happen under Option A - the
   * balance never moved, so the daily CREDIT_LIMIT_ACTIONS selection may not
   * pick it up.
   */
  test('the stock profile defers a breach inside the no-cut window and suspends outside it @auto-window',
    async ({}, testInfo) => {
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
        await note(testInfo, 'account for the morning-after (TC41) check', `${s.accountId} meter ${s.meter}`);

        if (!deferred) {
          await test.step('outside the window: the breach suspends', async () => {
            await breach(db, mdr, s, testInfo);
          });
          return;
        }

        await test.step('inside the window: the reading parks but nothing is suspended', async () => {
          const before = await balance(db, s.accountId);
          const file = mdrFile(await mdr.submitReading(s.meter, BREACH_READING));
          const rec = await poll(() => readingRecord(db, s.meter, file), r => !!r && r.status !== 'PENDING', 180_000, 5_000);
          console.log(`  breach reading: ${rec?.id} ${rec?.status}/${rec?.errorcode}`);
          expect(`${rec?.status}/${rec?.errorcode}`, 'a reading the balance cannot fund must still PARK')
            .toBe('SUSPENDED/CURRENCY_CREDIT_LIMIT_EXCEEDED');
          expect(await balance(db, s.accountId), 'a parked reading must charge nothing').toBe(before);
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
          console.log(`\n  Re-check ${s.accountId} after ${win.end} CR on a weekday: per TC41 it should then be ` +
            `suspended; per our Option A notes it may not be.\n`);
        });
      } finally {
        await db.disconnect();
      }
    });
});
