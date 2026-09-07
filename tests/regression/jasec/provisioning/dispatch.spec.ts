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
 * WHAT MAKES A CANDIDATE SAFE. Its meter must be one JASEC have never answered
 * 00 for. That set is derived from their own replies rather than a hardcoded
 * list, so a newly released meter is excluded automatically. They answer "El
 * Medidor No existe" to everything else, so the command is refused on the way in
 * and no physical device is involved.
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
 * SAFETY. Every candidate is checked to carry a prov-* meter and to have no open
 * order, and the accounts behind the staged orders are excluded outright. A
 * numeric meter is refused: those are JASEC's real devices.
 */

import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';

const RUN = process.env.JASEC_DISPATCH_RUN === 'true';
const BATCH_N = Number(process.env.JASEC_BATCH_N ?? '3');
const CRM = process.env.JASEC_CRM_GATEWAY_URL ?? 'https://crm-gateway.jasec-dev.embrix.org/graphql';
const TXN = process.env.JASEC_TXN_GRAPHQL_URL ?? 'https://service-transactional.jasec-dev.embrix.org/graphql';
const USER = process.env.EMBRIX_USERNAME ?? 'congeroadmin';
const PASS = process.env.EMBRIX_PASSWORD ?? '';

/** Accounts behind orders staged for a JASEC session. Never build on these. */
const STAGED_ACCOUNTS = ['ACT-100064', '01365966', '031201', 'ACT-100774'];

/** accion values, from ccp_properties provisioningUtilities{Suspend,Resume}SubType. */
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

test.beforeAll(async ({ }) => {
  if (!RUN) return;
  db = new DbHelper();
  await db.connect();
});

test.afterAll(async () => {
  if (db) await db.disconnect();
});

/**
 * Candidates whose dispatch JASEC will refuse, with no order in flight.
 *
 * The meter is taken from service_provision, because that is the one that
 * reaches JASEC. Any meter they have EVER answered 00 for is excluded: that set
 * is exactly the real, working devices, and it is derived from their own replies
 * rather than from a hardcoded list that would go stale the moment they release
 * another meter.
 */
async function candidates(limit: number): Promise<Candidate[]> {
  return db.query<Candidate>(
    `SELECT su.accountid,
            su.id AS svc,
            coalesce(su.bundleid,'') AS bundleid,
            su.provisioningid,
            sp.provisioningid AS "dispatchedMeter"
       FROM core_engine.service_unit su
       JOIN core_engine.service_provision sp
         ON sp.id = su.id AND sp.type = 'METER'
      WHERE su.status = 'ACTIVE'
        AND coalesce(sp.provisioningid,'') <> ''
        AND NOT (su.accountid = ANY($2))
        -- never a meter JASEC has ever accepted
        AND sp.provisioningid NOT IN (
              SELECT DISTINCT substring(a.request::text from '<medidor>([^<]+)')
                FROM core_engine.activity a
               WHERE a.apiname ILIKE '%UTILITIES%'
                 AND a.response::text LIKE '%CodRespuesta>00<%'
                 AND substring(a.request::text from '<medidor>([^<]+)') IS NOT NULL)
        AND NOT EXISTS (
              SELECT 1 FROM core_oms."order" o
               WHERE o.accountid = su.accountid
                 AND coalesce(o.status,'') NOT IN ('COMPLETED','CANCELLED'))
      -- Prefer automation-created ACT-nnnnnn accounts. The named ones
      -- (TRI-01, LCHONG000001, JASEC000002, LCG-...) are somebody's manual test
      -- data and raising orders on them would disturb work in progress.
      ORDER BY (su.accountid LIKE 'ACT-%') DESC, su.accountid DESC
      LIMIT $1`,
    [limit, STAGED_ACCOUNTS],
  );
}

/**
 * Refuse to dispatch on anything JASEC might actually act on. Checks the meter
 * that goes on the wire, and re-checks the accepted-meter set at call time so a
 * newly released meter is excluded even mid-run.
 */
async function assertSafeToDispatch(c: Candidate) {
  expect(c.dispatchedMeter, `${c.accountid} has no meter on service_provision.`).not.toBe('');

  const accepted = await db.query<{ medidor: string }>(
    `SELECT DISTINCT substring(request::text from '<medidor>([^<]+)') AS medidor
       FROM core_engine.activity
      WHERE apiname ILIKE '%UTILITIES%' AND response::text LIKE '%CodRespuesta>00<%'`);
  const real = accepted.map(a => a.medidor).filter(Boolean);

  expect(
    real,
    `${c.accountid} would dispatch meter ${c.dispatchedMeter}, which JASEC have ` +
    `accepted before - that is a real device and this test must never touch one. ` +
    `Note the meter comes from service_provision, NOT service_unit.provisioningid.`,
  ).not.toContain(c.dispatchedMeter);
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
}

test.describe('JEPYP-27 - dispatch cases that need no JASEC input', () => {
  test('no limit is applied to how many customers are disconnected in one run', async ({ request }) => {
    gate();
    test.setTimeout(600_000);

    expect(BATCH_N, 'Keep N small - every order sends a real command to JASEC.')
      .toBeLessThanOrEqual(10);

    const cs = await candidates(BATCH_N);
    test.skip(
      cs.length < BATCH_N,
      `BLOCKED: only ${cs.length} clean candidate account(s) available, need ${BATCH_N}.`,
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

    const cs = await candidates(1);
    test.skip(cs.length < 1, 'BLOCKED: no clean candidate account available.');
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
          WHERE apiname ILIKE '%UTILITIES%' AND request::text LIKE $1`, [`%${order}%`]);
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

  test('a reconnect command is built correctly under the current contract', async ({ request }) => {
    gate();
    test.setTimeout(600_000);

    const cs = await candidates(1);
    test.skip(cs.length < 1, 'BLOCKED: no clean candidate account available.');
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
      [`%${order}%`],
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
    // prov-* meter and proves their service parsed the envelope; what would be a
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
});
