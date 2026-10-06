/**
 * JEPYP-27 dispatch cases that need NO input from JASEC.
 *
 * Both cases below looked blocked on JASEC and are not. The insight is that for
 * these two questions a REFUSAL proves the point exactly as well as an
 * acceptance, so a meter JASEC reject is not a limitation - it is the safest
 * possible test fixture.
 *
 *   batch / no limit   the ticket answers "NO LIMIT" on how many customers may
 *                      be disconnected in one run. That is a question about
 *                      whether EMBRIX throttles, which is entirely our side.
 *                      Whether JASEC accept each command is irrelevant.
 *
 *   reconnect payload  what accion = C actually puts on the wire. A RESUME must
 *                      send C and never D - a crossed mapping would cut power on
 *                      a reconnect.
 *
 *   reconnect retries  whether the reconnect sequence retries, and how far
 *                      apart. Measured rather than assumed.
 *
 * WHICH METER ACTUALLY GOES ON THE WIRE. Not the obvious one. The engine
 * dispatches core_engine.service_provision.provisioningid (type METER, keyed by
 * service-unit id) - NOT service_unit.provisioningid. ACT-100797 carries
 * "prov-ACT-100797-ORD-1383" in the latter and dispatched 00210018641144770.
 * An earlier version of this spec guarded the prov-* column and was therefore
 * safe only by luck. assertSafeToDispatch checks the value that is really sent.
 *
 * WHAT MAKES A CANDIDATE SAFE. It is SEEDED by this spec, with a meter named
 * M-QADISP-<suffix> that cannot be a JASEC device, and that meter must never have
 * been accepted by JASEC (re-checked at dispatch time). JASEC answer "El Medidor
 * No existe" to it, so the command is refused on the way in and no physical
 * device is involved.
 *
 * It used to BORROW candidates: any ACTIVE metered account with no open order,
 * preferring ACT-* ids but falling back to named manual accounts (TRI-01,
 * LCHONG...). On dev nearly every such meter is numeric - JASEC's real device
 * shape - and only "never answered 00" kept a real meter off the wire. TC-116
 * also left the borrowed account's service unit SUSPENDED. Seeding its own
 * subject removes both: nothing borrowed, nothing to restore.
 *
 * Verified 2026-09-07: a refused dispatch leaves service_unit ACTIVE - the
 * suspension only happens on the callback - so these runs do not suspend anyone.
 * ORD-1058 and ORD-1371 both sit in a failed state with their service unit still
 * ACTIVE, which is the evidence for that.
 *
 * GATED, because these DO reach JASEC's live AMI:
 *
 *   JASEC_DISPATCH_RUN=true     explicit opt-in
 *   JASEC_BATCH_N=3             how many orders the batch case raises (default 3)
 *   EMBRIX_PASSWORD=...         to sign in
 *
 * MIND THE RETRY MULTIPLIER. Both sequences now carry retryCountOnError 3 with a
 * 30 second pause, so ONE refused order produces FOUR commands over about 96
 * seconds - measured on ORD-1434 at +6s, +33s, +64s, +96s. Budget accordingly:
 * N=2 is roughly 8 commands, N=3 roughly 12. Four junk commands on 2026-09-03
 * caused friction with JASEC, so keep N small and agree anything larger with the
 * team first. The default is deliberately 3.
 *
 * A reprocessed order is the exception - it gets a single attempt, because
 * retriedcount is not reset. Confirmed by the team as expected behaviour.
 *
 * SAFETY. Every candidate is an account this spec just seeded, with an M-QADISP-
 * meter and no open order; the accounts behind the staged orders are excluded
 * outright. assertSafeToDispatch (helpers/provisioning-safety.helper.ts) refuses
 * any meter that is not a QA meter or that JASEC have ever accepted.
 */

import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { uniqueRunSuffix } from '../../../../fixtures/create-prepaid-account.helper';
import {
  STAGED_ACCOUNTS, assertSafeToDispatch as assertMeterSafe,
} from '../../../../helpers/provisioning-safety.helper';

const RUN = process.env.JASEC_DISPATCH_RUN === 'true';
const BATCH_N = Number(process.env.JASEC_BATCH_N ?? '3');

/**
 * EVERY URL HERE FOLLOWS THE TENANT, and the tenant comes from TEST_ENV.
 *
 * These three used to default to a hardcoded `jasec-dev` host when their
 * JASEC_*_URL override was unset — and those overrides are NOT part of `.env`,
 * which carries TEST_ENV / EMBRIX_BASE_URL / DB_NAME. So a preprod run silently
 * used dev endpoints while DbHelper (which DOES read DB_NAME) correctly used the
 * preprod database.
 *
 * That split is worse than either half being wrong. On 2026-09-15 this selected
 * a candidate from PREPROD and raised the SUSPEND order on DEV (ORD-1582,
 * ACT-100054). It was invisible because account ids collide across tenants: the
 * preprod account id existed on dev too, so nothing looked out of place.
 *
 * A hardcoded environment in a default is the same defect class as the stale
 * "dev only" and "SMTP down" claims removed elsewhere — a dev fact frozen into
 * code that also runs against preprod.
 */
const TENANT = (process.env.TEST_ENV ?? 'jasec-dev').trim();
// Runs on jasec-dev, jasec-preprod and jasec (prod) - this spec dispatches to a real AMI. It used to THROW on any other
// tenant, which on JASEC prod (2026-09-30) took down the whole jasec-provisioning
// project at load (0 tests listed). Now it SKIPS every test with a BLOCKED reason:
// just as fail-closed, without breaking the sibling specs.
// 'jasec' = PROD build 1, opened 2026-10-01 for Block A (Anh): QA meters only (the AMI refuses
// them; we send JASEC's callback ourselves), each case behind its own *_RUN flag, and the
// spec still BLOCKS itself while provisioningEnabled is not true.
const TENANT_REFUSED = !/^jasec(-dev|-preprod)?$/.test(TENANT);
test.skip(() => TENANT_REFUSED,
  `BLOCKED, not failed: this spec dispatches to a real AMI and runs on jasec-dev / jasec-preprod / jasec (prod) only ` +
  `(got '${TENANT}'). On prod it needs provisioningEnabled=true, accepted test meters and an agreed window.`);
const CRM = process.env.JASEC_CRM_GATEWAY_URL ?? `https://crm-gateway.${TENANT}.embrix.org/graphql`;
const TXN = process.env.JASEC_TXN_GRAPHQL_URL ?? `https://service-transactional.${TENANT}.embrix.org/graphql`;
const USER = process.env.EMBRIX_USERNAME ?? 'congeroadmin';
const PASS = process.env.EMBRIX_PASSWORD ?? '';

/** Every candidate meter this spec seeds starts with this. */
const METER_PREFIX = 'M-QADISP-';

/** accion values, from ccp_properties provisioningUtilities{Suspend,Resume}SubType. */
// Follows TENANT for the same reason as CRM/TXN above — a callback posted to the
// wrong tenant's gateway drives the effect chain on an environment nobody is testing.
const CALLBACK_URL =
  process.env.JASEC_PROVISION_CALLBACK_URL
  ?? `https://provision-gateway.${TENANT}.embrix.org/updateProvisioningRequest`;

const ACCION_SUSPEND = 'D';
const ACCION_RESUME = 'C';

type Candidate = {
  accountid: string;
  svc: string;
  bundleid: string;
  provisioningid: string;
  /**
   * The meter that will ACTUALLY go on the wire. Verified 2026-09-07: the engine
   * dispatches core_engine.service_provision.provisioningid (type METER, keyed by
   * service-unit id), NOT service_unit.provisioningid. ACT-100797 carries
   * "prov-ACT-100797-ORD-1383" in the latter but dispatched 00210018641144770.
   * Guarding the wrong column is how a test ends up sending a command to a real
   * device believing it is safe.
   */
  dispatchedMeter: string;
};

let db: DbHelper;
let token = '';

test.describe.configure({ mode: 'serial' });

let dbUp = false;
let dbError = '';

test.beforeAll(async ({ }) => {
  if (!RUN) return;
  db = new DbHelper();
  try {
    await db.connect();
    dbUp = true;
  } catch (e) {
    dbError = String((e as Error)?.message ?? e);
  }
});

test.afterAll(async () => {
  if (dbUp) await db.disconnect();
});

/** Why the last seedCandidates() came back short - printed in the BLOCKED reason. */
let seedProblem = '';

/**
 * Seed `n` fresh candidates whose dispatch JASEC will refuse, with no order in
 * flight. Each is an account + meter made by PrepaidSeedHelper; the NEW order
 * completes asynchronously, so re-read until the metered service unit is ACTIVE
 * and nothing is left open. Returns fewer than `n` (with seedProblem set) rather
 * than throwing, so the caller reports BLOCKED - a seeding hiccup is an unmet
 * precondition, not a dispatch defect.
 */
async function seedCandidates(n: number): Promise<Candidate[]> {
  seedProblem = '';
  const seed = new PrepaidSeedHelper();
  const out: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    const suffix = uniqueRunSuffix();
    const meter = `${METER_PREFIX}${suffix}`;
    let accountId = '';
    try {
      ({ accountId } = await seed.seed({ meter, customerId: `QADISP-${suffix}`, name: `QADISP ${suffix}` }));
    } catch (e) {
      seedProblem = `seeding failed: ${(e as Error).message.slice(0, 300)}`;
      return out;
    }
    let row: (Candidate & { status: string; open: string }) | undefined;
    for (let t = 0; t < 24; t++) {
      const rows = await db.query<Candidate & { status: string; open: string }>(
        `SELECT su.accountid,
                su.id AS svc,
                coalesce(su.bundleid,'') AS bundleid,
                su.provisioningid,
                sp.provisioningid AS "dispatchedMeter",
                su.status,
                (SELECT count(*)::text FROM core_oms."order" o
                  WHERE o.accountid = su.accountid
                    AND coalesce(o.status,'') NOT IN ('COMPLETED','CANCELLED')) AS open
           FROM core_engine.service_unit su
           JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
          WHERE su.accountid = $1 AND NOT (su.accountid = ANY($2))`,
        [accountId, STAGED_ACCOUNTS]);
      row = rows.length === 1 ? rows[0] : undefined;
      if (row && row.status === 'ACTIVE' && row.open === '0') break;
      await new Promise(r => setTimeout(r, 5_000));
    }
    if (!row || row.status !== 'ACTIVE' || row.open !== '0') {
      seedProblem = `${accountId} did not reach an ACTIVE metered service unit with no open order ` +
        `within 2 min (${row ? `${row.status}, ${row.open} open order(s)` : 'no metered service unit'})`;
      return out;
    }
    expect(row.dispatchedMeter, `${accountId}: service_provision holds ${row.dispatchedMeter}, not ${meter}`)
      .toBe(meter);
    console.log(`  seeded candidate ${accountId}, meter ${meter}`);
    out.push({
      accountid: row.accountid, svc: row.svc, bundleid: row.bundleid,
      provisioningid: row.provisioningid, dispatchedMeter: row.dispatchedMeter,
    });
  }
  return out;
}

/**
 * Refuse to dispatch on anything JASEC might actually act on. Re-reads the meter
 * on service_provision (what goes on the wire, NOT service_unit.provisioningid),
 * requires it to be an M-QADISP- meter, and re-checks the accepted-meter set at
 * call time so a newly released meter is excluded even mid-run.
 */
async function assertSafeToDispatch(c: Candidate) {
  expect(c.dispatchedMeter, `${c.accountid} has no meter on service_provision.`).not.toBe('');
  await assertMeterSafe(db, { accountId: c.accountid, svc: c.svc, meter: c.dispatchedMeter }, METER_PREFIX);
}

async function signIn(request: any): Promise<string> {
  const attempt = async (url: string): Promise<string> => {
    const res = await request.post(url, {
      headers: { 'Content-Type': 'application/json' },
      data: { query: `query { userLogin(input:{userName:"${USER}",password:"${PASS}"}){ token } }` },
      timeout: 60_000,
    });
    return (await res.text()).match(/"token":"([^"]+)"/)?.[1] ?? '';
  };
  // crm-gateway does not always serve userLogin; service-transactional does.
  return (await attempt(CRM)) || (await attempt(TXN));
}

async function gql(request: any, url: string, query: string, timeout = 240_000): Promise<string> {
  const res = await request.post(url, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { query },
    timeout,
  });
  return res.text();
}

/** Raise an order and push it through provisioning. Returns the order id. */
async function raiseAndDispatch(
  request: any, c: Candidate, type: 'SUSPEND' | 'RESUME',
): Promise<string> {
  // Plain double quotes. Playwright JSON-encodes `data` itself, so escaping them
  // here would put literal backslashes into the GraphQL document and the server
  // returns an empty body with no useful error.
  const bundle = c.bundleid ? `, bundleId: "${c.bundleid}"` : '';
  const created = await gql(request, TXN,
    `mutation { createOrder(input:{type: ${type}, accountId: "${c.accountid}", ` +
    `userId: "${USER}", subscriptionReason: ACCOUNT_STATUS_CHANGE, ` +
    `services:[{index:1, serviceType: ELECTRICITY, action: ${type}, ` +
    `provisioningId: "${c.provisioningid}"${bundle}}]}){ id status } }`);
  const id = created.match(/"id":"(ORD-[0-9]+)"/)?.[1] ?? '';
  expect(id, `createOrder did not return an order id for ${c.accountid}: ${created.slice(0, 400)}`)
    .not.toBe('');
  await gql(request, CRM, `mutation { reSubmitOrder(input:{id: "${id}"}){ id status } }`);
  return id;
}

async function commandCount(): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM core_engine.activity WHERE apiname ILIKE '%UTILITIES%'`);
  return Number(r[0]?.n ?? 0);
}

/** Poll, re-reading each time - an auto-retrying assert would re-check one read. */
async function waitForCommands(target: number, seconds = 180): Promise<number> {
  let n = await commandCount();
  for (let i = 0; i < seconds / 5 && n < target; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    n = await commandCount();
  }
  return n;
}

function gate() {
  test.skip(!RUN, 'GATED: dispatches to JASEC\'s live AMI. Set JASEC_DISPATCH_RUN=true to run.');
  test.skip(!PASS, 'BLOCKED: EMBRIX_PASSWORD not set, cannot sign in.');
  test.skip(!dbUp, `BLOCKED: cannot reach the JASEC database. ${dbError}`);
}

test.describe('JEPYP-27 - dispatch cases that need no JASEC input', () => {
  test('no limit is applied to how many customers are disconnected in one run', async ({ request }) => {
    gate();
    test.setTimeout(600_000);

    expect(BATCH_N, 'Keep N small - every order sends a real command to JASEC.')
      .toBeLessThanOrEqual(10);

    const cs = await seedCandidates(BATCH_N);
    test.skip(
      cs.length < BATCH_N,
      `BLOCKED: only ${cs.length} of ${BATCH_N} candidate account(s) seeded - ${seedProblem}.`,
    );

    for (const c of cs) await assertSafeToDispatch(c);

    token = await signIn(request);
    expect(token, 'Sign in failed at both gateways.').not.toBe('');

    const before = await commandCount();
    const orders: string[] = [];
    for (const c of cs) orders.push(await raiseAndDispatch(request, c, 'SUSPEND'));
    console.log(`  raised ${orders.length} SUSPEND order(s): ${orders.join(', ')}`);

    const after = await waitForCommands(before + BATCH_N);
    console.log(`  raw commands: ${before} -> ${after}`);

    // COUNT DISTINCT ORDERS, NOT COMMANDS. Each refused command is retried
    // retrycountonerror times, so one order produces about four commands. A raw
    // "commands >= N" check would pass on a single order that retried, which
    // would prove nothing about throttling. Ask instead how many of the orders
    // we raised actually reached the AMI at least once.
    const dispatched = await db.query<{ ord: string }>(
      `SELECT DISTINCT substring(request::text from 'ORD-[0-9]+') AS ord
         FROM core_engine.activity
        WHERE apiname ILIKE '%UTILITIES%'
          AND substring(request::text from 'ORD-[0-9]+') = ANY($1)`,
      [orders],
    );
    const reached = dispatched.map(d => d.ord).filter(Boolean);
    const missing = orders.filter(o => !reached.includes(o));
    console.log(`  orders that reached the AMI: ${reached.length}/${orders.length}`);

    expect(
      reached.length,
      `Raised ${orders.length} orders but only ${reached.length} reached the AMI. ` +
      `Never dispatched: ${missing.join(', ') || 'none'}. The ticket answers ` +
      `"NO LIMIT" to how many customers may be disconnected in one run, so a ` +
      `shortfall means something is capping or dropping us.`,
    ).toBe(orders.length);

    // Suspension happens on the callback, never on dispatch. These were all
    // refused, so nobody should have been suspended.
    const suspended = await db.query<{ accountid: string }>(
      `SELECT accountid FROM core_engine.service_unit
        WHERE accountid = ANY($1) AND status <> 'ACTIVE'`,
      [cs.map(c => c.accountid)],
    );
    expect(
      suspended.map(s => s.accountid),
      'A refused dispatch must not suspend anyone - suspension is callback-driven.',
    ).toHaveLength(0);
  });

  /**
   * Does the reconnect sequence actually retry, and how far apart?
   *
   * The team changed three things on 2026-09-07. This exercises the two that the
   * SUSPEND reprocess test could not reach:
   *
   *   PROV_SEQ500092 (RESUME) retryCountOnError  unset -> 3
   *   ccp waitTimeForNextSequence               no row -> 30
   *
   * Before the change a failed reconnect was final on the first attempt. After
   * it, a refused dispatch should produce 1 attempt + 3 retries = 4 commands,
   * roughly 30 seconds apart.
   *
   * Timing is measured by POLLING in wall-clock, not from createddate - that
   * column is CCP-stamped and the frozen clock moves around, so it cannot be
   * used to measure an interval.
   *
   * COSTS UP TO FOUR REFUSED COMMANDS. That is the point of the case: the
   * retries are what is being measured. Runs only on a meter JASEC reject.
   */
  test('a failed reconnect is retried per configuration', async ({ request }) => {
    gate();
    test.setTimeout(900_000);

    const cs = await seedCandidates(1);
    test.skip(cs.length < 1, `BLOCKED: could not seed a candidate account - ${seedProblem}.`);
    const c = cs[0];
    await assertSafeToDispatch(c);
    console.log(`  ${c.accountid}, meter on the wire: ${c.dispatchedMeter}`);

    token = await signIn(request);
    expect(token, 'Sign in failed.').not.toBe('');

    const t0 = Date.now();
    const order = await raiseAndDispatch(request, c, 'RESUME');
    console.log(`  raised ${order}`);

    const seen: number[] = [];
    const countFor = async (): Promise<number> => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM core_engine.activity
          WHERE apiname ILIKE '%UTILITIES%' AND request::text LIKE $1`,
        [`%>${order}<%`]); // between tags, so ORD-18 cannot match ORD-1869
      return Number(r[0]?.n ?? 0);
    };

    // Watch for ~4 minutes: 3 retries at 30s plus ~17s per AMI answer.
    let n = 0;
    for (let i = 0; i < 48; i++) {
      const cur = await countFor();
      while (seen.length < cur) {
        seen.push(Math.round((Date.now() - t0) / 1000));
        console.log(`    command ${seen.length} at +${seen[seen.length - 1]}s`);
      }
      n = cur;
      if (n >= 4) break;
      await new Promise(r => setTimeout(r, 5_000));
    }

    const gaps = seen.slice(1).map((t, i) => t - seen[i]);
    console.log(`  total commands: ${n}`);
    console.log(`  gaps between them: ${gaps.length ? gaps.map(g => g + 's').join(', ') : '(none)'}`);

    const seq = await db.query<{ status: string; retried: number }>(
      `SELECT coalesce(status,'') AS status, retriedcount AS retried
         FROM core_oms.order_prov_sequence_list WHERE id = $1`, [order]);
    console.log(`  sequence: ${seq[0]?.status}, retriedcount ${seq[0]?.retried}`);

    expect(
      n,
      `The reconnect sequence dispatched ${n} command(s). retryCountOnError is now ` +
      `3 on PROV_SEQ500092, so a refused dispatch should produce 1 attempt plus 3 ` +
      `retries. If this is 1, the new retry count is not being applied to the ` +
      `reconnect path.`,
    ).toBeGreaterThan(1);
  });

  // API-SHAPED CONTROL since 2026-10-06. TC-119 is now judged on the Resume Order SCREEN journey
  // (suspend-resume-orders @tc-119): this builds its RESUME with createOrder(services:[...]), a shape
  // production never creates. Kept as a control for the wire format.
  test('a reconnect command is built correctly under the current contract', async ({ request }) => {
    gate();
    test.setTimeout(600_000);

    const cs = await seedCandidates(1);
    test.skip(cs.length < 1, `BLOCKED: could not seed a candidate account - ${seedProblem}.`);
    const c = cs[0];
    await assertSafeToDispatch(c);
    console.log(`  candidate ${c.accountid}, meter on the wire: ${c.dispatchedMeter}`);

    token = await signIn(request);
    expect(token, 'Sign in failed at both gateways.').not.toBe('');

    const before = await commandCount();
    const order = await raiseAndDispatch(request, c, 'RESUME');
    console.log(`  raised RESUME order ${order} on ${c.accountid}`);
    await waitForCommands(before + 1);

    const rows = await db.query<{ id: string; request: string; response: string }>(
      `SELECT id, request::text AS request, coalesce(response::text,'') AS response
         FROM core_engine.activity
        WHERE apiname ILIKE '%UTILITIES%' AND request::text LIKE $1
        ORDER BY id DESC LIMIT 1`,
      [`%>${order}<%`],
    );
    expect(rows.length, `No command was dispatched for ${order}.`).toBe(1);
    const { request: req, response: res } = rows[0];

    // The whole point: what went on the wire for a RESUME, under v10.
    expect(
      req.match(/<accion>([^<]*)</)?.[1],
      `A RESUME must send accion=${ACCION_RESUME}. If this says ${ACCION_SUSPEND}, ` +
      `the suspend and resume subtypes are crossed and a reconnect would cut power.`,
    ).toBe(ACCION_RESUME);

    expect(req, 'The reconnect payload must carry the current correlation fields.')
      .toContain('<numeroOrden>');
    expect(req).toContain('<numeroCuenta>');
    expect(req).not.toContain('<numOrder>');

    for (const f of ['medidor', 'accion', 'numeroOrden', 'numeroCuenta']) {
      const v = req.match(new RegExp(`<${f}>([^<]*)<`))?.[1] ?? '';
      expect(v, `<${f}> is empty in the reconnect payload.`).not.toBe('');
      expect(v, `<${f}> went out as a literal token.`).not.toMatch(/^--.*--$/);
    }

    // JASEC must have answered something. A refusal is the expected outcome on a
    // QA (M-QADISP-) meter and proves their service parsed the envelope; what would be a
    // real problem is no answer at all.
    const code = res.match(/CodRespuesta>([^<]*)</)?.[1] ?? '';
    const descr = res.match(/DescripcionRespuesta>([^<]*)</)?.[1] ?? '';
    console.log(`  JASEC answered: ${code || '(no SOAP body)'} ${descr}`);
    expect(
      res,
      'JASEC returned no response at all to the reconnect command. A refusal is ' +
      'expected and fine on a rejected meter - silence is not.',
    ).not.toBe('');
  });

  /**
   * TC-116. An accepted callback drives the full effect chain.
   *
   * WHY THIS IS SAFE TO AUTOMATE, having previously been thought not to be.
   * The belief was that an order can only be closed by a callback once JASEC
   * accept a dispatched command, which would make every run cost the one meter
   * they have released. That is wrong, and the disproof was already in the
   * data: ORD-960/961/962/968 were all driven to COMPLETED by callbacks we
   * generated ourselves. What the endpoint requires is that a dispatch was
   * ATTEMPTED - that is what instantiates order_prov_sequence_list - not that
   * it succeeded. A dispatch JASEC REFUSE satisfies it exactly as well.
   *
   * So this raises its own subject on a meter JASEC always refuse, lets the
   * refusal land, and then closes the order with our own callback. Nothing
   * scarce is consumed and no real device is involved.
   *
   * WHAT IT PROVES that the refusal cases in inbound-contract.spec.ts cannot:
   * that ACCEPTANCE propagates. Order COMPLETED, the order service COMPLETED,
   * the service unit SUSPENDED - and the subscription still ACTIVE, because
   * suspending a service must not cancel the customer's subscription.
   */
  // API-SHAPED CONTROL since 2026-10-06. TC-116 is now judged on the Suspend Order SCREEN journey
  // (suspend-resume-orders @tc-116), the shape production creates (subscription-level, no service line).
  test('an accepted callback drives the full effect chain', async ({ request }) => {
    gate();
    token = await signIn(request);
    expect(token, 'Could not sign in.').not.toBe('');

    const cs = await seedCandidates(1);
    test.skip(cs.length < 1, `BLOCKED: could not seed a candidate account - ${seedProblem}.`);
    const c = cs[0];
    await assertSafeToDispatch(c);

    // The service unit must start ACTIVE, or SUSPENDED afterwards proves nothing.
    const before = await db.query<{ status: string }>(
      `SELECT status FROM core_engine.service_unit WHERE id = $1`, [c.svc]);
    expect(before[0]?.status, `${c.svc} is not ACTIVE to begin with.`).toBe('ACTIVE');

    const n0 = await commandCount();
    const order = await raiseAndDispatch(request, c, 'SUSPEND');
    await waitForCommands(n0 + 1);

    // Poll for the sequence row: that is what makes the order callback-eligible,
    // and it is written by the ATTEMPT, whatever JASEC answer.
    let seq = 0;
    for (let i = 0; i < 24 && seq === 0; i++) {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM core_oms.order_prov_sequence_list WHERE id = $1`,
        [order]);
      seq = Number(r[0]?.n ?? 0);
      if (seq === 0) await new Promise(r2 => setTimeout(r2, 5_000));
    }
    expect(seq, `${order} never instantiated a provisioning sequence, so no ` +
      `callback can be accepted for it. The dispatch was not attempted.`).toBeGreaterThan(0);

    const res = await request.post(CALLBACK_URL, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        orderId: order,
        accountId: c.accountid,
        status: 'COMPLETED',
        services: [{
          serviceType: 'ELECTRICITY', action: 'SUSPEND',
          bundleId: c.bundleid || 'NONE', provisioningId: c.provisioningid,
        }],
      },
      timeout: 120_000,
    });
    const raw = await res.text();
    expect(raw, `The callback was refused, so nothing downstream can be asserted. ` +
      `Body: ${raw.slice(0, 400)}`).toContain('FINALIZADO');

    // Poll each link of the chain - the callback is processed asynchronously,
    // so re-read rather than re-check one read.
    const settled = async () => {
      const r = await db.query<{ ord: string; svc: string; unit: string; sub: string }>(
        `SELECT o.status AS ord,
                coalesce((SELECT string_agg(DISTINCT s.status,'/') FROM core_oms.order_services s
                           WHERE s.id = o.id),'') AS svc,
                coalesce((SELECT su.status FROM core_engine.service_unit su
                           WHERE su.id = $2),'') AS unit,
                coalesce((SELECT string_agg(DISTINCT sb.status,'/') FROM core_engine.subscription sb
                           WHERE sb.accountid = o.accountid),'') AS sub
           FROM core_oms."order" o WHERE o.id = $1`, [order, c.svc]);
      return r[0];
    };
    let end = await settled();
    for (let i = 0; i < 36 && end?.ord !== 'COMPLETED'; i++) {
      await new Promise(r2 => setTimeout(r2, 5_000));
      end = await settled();
    }

    expect(end?.ord, `${order} did not complete on an accepted callback.`).toBe('COMPLETED');
    expect(end?.svc, `${order}'s order service did not complete.`).toBe('COMPLETED');
    expect(end?.unit,
      `The service unit is ${end?.unit}, not SUSPENDED. The callback was accepted ` +
      `and the order completed, but the suspension did not reach the service - ` +
      `an operator would see a green order over a customer still being supplied.`,
    ).toBe('SUSPENDED');
    expect(end?.sub,
      `The subscription is ${end?.sub}. Suspending a service must NOT change the ` +
      `subscription - billing continues while supply is cut.`,
    ).toBe('ACTIVE');

    console.log(`[TC-116] ${order} on ${c.accountid}: order ${end?.ord}, ` +
      `service ${end?.svc}, unit ${end?.unit}, subscription ${end?.sub}`);
  });
});
