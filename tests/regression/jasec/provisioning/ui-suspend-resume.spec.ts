/**
 * JEPYP-27 through the path real users take: the Core UI Suspend Order and
 * Resume Order screens, not a hand-built createOrder.
 *
 * WHY THIS EXISTS. Every provisioning spec before this one built its SUSPEND /
 * RESUME with `createOrder(... services:[...])`, which writes a
 * core_oms.order_services row. Nothing in production does that:
 *
 *   origin (jasec-dev, 2026-09-28)          orders   with a service line
 *   our API specs (congeroadmin)              60+     all
 *   CreditLimitBreach (automatic suspend)       1     0
 *   jasec-dev (automatic resume on top-up)      6     0
 *   Core UI Suspend Order screen                1     0   (ORD-1869)
 *
 * The screen sends `subscriptions:[...]` and no `services`
 * (SuspendSubscription.js onPressCreateButton). On ORD-1869 an accepted
 * callback suspended the subscription and the service unit but left the ORDER
 * at PROVISIONING_ERROR. The older effect-chain case (TC-116) passes only
 * because its subject has the service line production never creates.
 *
 * TWO TESTS, run separately (each is ~5 min and long runs get killed):
 *
 *   A  UI journey   Suspend Order screen -> Submit order -> 4 refused commands
 *                   -> callback -> Resume Order screen -> the same with accion C
 *   B  control      the same SUSPEND built the API way, same kind of account,
 *                   same callback. If B completes and A does not, the creation
 *                   path is the variable - which is what a defect needs.
 *
 * WHAT IS A FAIL AND WHAT IS NOT. The order not reaching COMPLETED after an
 * accepted callback is a FAIL and stays one (expect.soft, so the rest of the
 * journey still reports). "El Medidor No existe" on every command is EXPECTED:
 * the meter is invented by this spec, so JASEC refuse it and no device is
 * touched. A refusal proves the message was built and parsed, which is all
 * this case needs from their side.
 *
 * SAFETY. Each test seeds its own account with a meter named M-QAUI-<suffix>
 * and refuses to dispatch unless the meter going on the wire has that prefix
 * and has never been answered 00 - checked against service_provision, which is
 * the meter the engine really sends. About 8 refused commands per run of A and
 * 4 per run of B reach JASEC's live AMI.
 *
 * The callback is a direct POST in both tests, because in production it is
 * JASEC's system calling us - there is no screen for it.
 *
 * GATED (reaches JASEC's live AMI):
 *
 *   JASEC_UI_SUSPEND_RUN=true
 *   npx playwright test --project=jasec-provisioning-ui ui-suspend-resume --grep "@ui-journey"
 *   npx playwright test --project=jasec-provisioning-ui ui-suspend-resume --grep "@api-control"
 *
 * dev only. Preprod has no provisioningEnabled, so nothing dispatches there and
 * the test reports BLOCKED.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '../../../../fixtures/jasec-fixtures';
import type { APIRequestContext, TestInfo } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';
import { assertSafeToDispatch as assertMeterSafe } from '../../../../helpers/provisioning-safety.helper';
import { SuspendResumeOrderPage } from '../../../../pages/customer-hub/order-management/suspend-resume-order.page';

const RUN = process.env.JASEC_UI_SUSPEND_RUN === 'true';

const TENANT = (process.env.TEST_ENV ?? 'jasec-dev').trim();
if (!/^jasec-(dev|preprod)$/.test(TENANT)) {
  throw new Error(`ui-suspend-resume: TEST_ENV must be jasec-dev or jasec-preprod (got '${TENANT}').`);
}
const CRM = process.env.JASEC_CRM_GATEWAY_URL ?? `https://crm-gateway.${TENANT}.embrix.org/graphql`;
const TXN = process.env.JASEC_TXN_GRAPHQL_URL ?? `https://service-transactional.${TENANT}.embrix.org/graphql`;
const CALLBACK_URL = process.env.JASEC_PROVISION_CALLBACK_URL
  ?? `https://provision-gateway.${TENANT}.embrix.org/updateProvisioningRequest`;
const USER = process.env.EMBRIX_USERNAME ?? process.env.EMBRIX_USER ?? 'congeroadmin';
const PASS = process.env.EMBRIX_PASSWORD ?? '';

const METER_PREFIX = 'M-QAUI-';
const REASON = 'NOT_HAPPY';

/**
 * "Allow Partial Provisioning" is PRE-TICKED on the Suspend/Resume screens
 * (from ccp partialProvisioningEnabled=true), so a screen order carries
 * isPartialFulfillmentAllowed=true. crm-gateway PGOmsService.provisionOrder then
 * takes the partial branch - `order.isPartialFulfillmentAllowed || (PARTIAL && !SUSPEND...)`,
 * an && / || precedence slip - which only completes an order whose order_services
 * rows are all COMPLETED, and a screen order has none. Every stuck order had the
 * flag true; every completed one had it empty.
 *
 * JASEC_UI_PARTIAL=off unticks it before CREATE - the isolation run for that
 * reading, and the workaround a user could apply today.
 */
const UNTICK_PARTIAL = (process.env.JASEC_UI_PARTIAL ?? '').toLowerCase() === 'off';

/** Apply the switch, then read the flag back - a click is not proof it stuck. */
async function applyPartialSwitch(ui: SuspendResumeOrderPage, db: DbHelper, order: string) {
  const r = await db.query<{ p: string }>(
    `SELECT coalesce(ispartialfulfillmentallowed::text,'<null>') AS p FROM core_oms."order" WHERE id = $1`, [order]);
  console.log(`  ${order}: isPartialFulfillmentAllowed=${r[0]?.p}`);
  if (UNTICK_PARTIAL) {
    expect(r[0]?.p, `${order}: "Allow Partial Provisioning" was unticked but the order still carries it`)
      .not.toBe('true');
  }
}

// The clock is shared; the seeder dates the account AT the current CCP date,
// which is exactly what the Suspend screen's effective-date filter needs.
test.use({ ccpBaseline: null });

type Seeded = { accountId: string; newOrder: string; meter: string; svc: string; sub: string; provId: string };
type Command = { id: string; ord: string; accion: string; medidor: string; cuenta: string; answer: string };

// ── helpers ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function seedAccount(db: DbHelper, logger: TestLogger, tag: string): Promise<Seeded> {
  const suffix = uniqueRunSuffix();
  const meter = `${METER_PREFIX}${suffix}`;
  const { accountId, orderId } = await new PrepaidSeedHelper(logger).seed({
    meter, customerId: `${tag}-${suffix}`, name: `${tag} ${suffix}`,
  });
  // The NEW order completes asynchronously - the service unit and its METER row
  // appear a few seconds after seed() returns. Re-read until both exist.
  const read = () => db.query<{ svc: string; sub: string; provid: string; status: string }>(
    `SELECT su.id AS svc, su.subscriptionid AS sub, su.provisioningid AS provid, su.status
       FROM core_engine.service_unit su
       JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
      WHERE su.accountid = $1`, [accountId]);
  const rows = await waitFor(read, r => r.length === 1 && r[0].status === 'ACTIVE', 24);
  const neworder = (await db.query<{ status: string }>(
    `SELECT status FROM core_oms."order" WHERE id = $1`, [orderId]))[0]?.status;
  expect(rows.length, `seeded ${accountId} has no ACTIVE metered service unit after 2 min ` +
    `(NEW order ${orderId} is ${neworder})`).toBe(1);
  console.log(`\n  seeded ${accountId} / ${orderId} / meter ${meter} / ${rows[0].svc}\n`);
  return { accountId, newOrder: orderId, meter, svc: rows[0].svc, sub: rows[0].sub, provId: rows[0].provid };
}

/** The meter that will really go on the wire must be ours and never accepted. */
async function assertSafeToDispatch(db: DbHelper, s: Seeded) {
  await assertMeterSafe(db, s, METER_PREFIX);
}

async function commands(db: DbHelper, order: string): Promise<Command[]> {
  return db.query<Command>(
    `SELECT id,
            substring(request::text from 'ORD-[0-9]+') AS ord,
            coalesce(substring(request::text from '<accion>([A-Z])</accion>'),'') AS accion,
            coalesce(substring(request::text from '<medidor>([^<]+)'),'') AS medidor,
            coalesce(substring(request::text from '<numeroCuenta>([^<]+)'),'') AS cuenta,
            coalesce(substring(response::text from 'DescripcionRespuesta>([^<]+)'),
                     substring(response::text from 'errorMsg": *"([^"]+)'), '') AS answer
       FROM core_engine.activity
      WHERE apiname ILIKE '%UTILITIES%' AND request::text LIKE $1
      ORDER BY id`, [`%<numeroOrden>${order}</numeroOrden>%`]);
}

async function orderState(db: DbHelper, order: string) {
  const r = await db.query<{ status: string; type: string; svclines: string; seq: string; retried: string }>(
    `SELECT o.status, o.type,
            (SELECT count(*)::text FROM core_oms.order_services s WHERE s.id = o.id) AS svclines,
            coalesce((SELECT string_agg(l.status,'/') FROM core_oms.order_prov_sequence_list l WHERE l.id = o.id),'') AS seq,
            coalesce((SELECT max(l.retriedcount)::text FROM core_oms.order_prov_sequence_list l WHERE l.id = o.id),'') AS retried
       FROM core_oms."order" o WHERE o.id = $1`, [order]);
  return r[0];
}

async function accountState(db: DbHelper, s: Seeded) {
  const r = await db.query<{ sub: string; svc: string }>(
    `SELECT (SELECT status FROM core_engine.subscription WHERE id = $1) AS sub,
            (SELECT status FROM core_engine.service_unit WHERE id = $2) AS svc`, [s.sub, s.svc]);
  return r[0];
}

/** Wait until the order stops dispatching: sequence FAILED and 4 commands (1 + 3 retries). */
async function waitForDispatchToSettle(db: DbHelper, order: string): Promise<Command[]> {
  let cmds: Command[] = [];
  for (let i = 0; i < 40; i++) {           // ~4 min; measured cadence is +6/+33/+64/+96 s
    const st = await orderState(db, order);
    cmds = await commands(db, order);
    if (st?.status === 'PROVISIONING_ERROR' && st.seq.includes('FAILED') && cmds.length >= 4) break;
    if (cmds.some(c => /Registrada/i.test(c.answer))) break;   // accepted - stop at once
    await sleep(6_000);
  }
  return cmds;
}

async function postCallback(request: APIRequestContext, s: Seeded, order: string, type: 'SUSPEND' | 'RESUME') {
  const res = await request.post(CALLBACK_URL, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      accountId: s.accountId, orderType: type, orderId: order, status: 'COMPLETED',
      services: [{
        serviceType: 'ELECTRICITY', action: type, bundleId: 'B-100000-E',
        provisioningDataType: 'METER', provisioningId: s.provId,
      }],
    },
    timeout: 120_000,
  });
  const body = await res.text();
  console.log(`  callback ${type} ${order}: HTTP ${res.status()} ${body.slice(0, 200)}`);
  return body;
}

/** Poll the effect, which is asynchronous. Re-reads inside the loop. */
async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, tries = 18, gap = 5_000): Promise<T> {
  let v = await read();
  for (let i = 0; i < tries && !done(v); i++) { await sleep(gap); v = await read(); }
  return v;
}

async function shot(page: any, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

async function preconditions(db: DbHelper) {
  const p = await db.query<{ value: string }>(
    `SELECT value FROM core_config.ccp_properties WHERE property = 'provisioningEnabled'`);
  blockedIf(p[0]?.value !== 'true',
    `provisioningEnabled is '${p[0]?.value ?? '<unset>'}' on ${TENANT}, so no order dispatches to the AMI ` +
    `and there is no provisioning flow to test. (Preprod is like this; dev is true.)`);
}

/** Checks shared by A and B once a SUSPEND order exists and has been submitted. */
async function assertSuspendDispatch(db: DbHelper, s: Seeded, order: string) {
  const cmds = await waitForDispatchToSettle(db, order);
  console.log(cmds.map(c => `  ${c.id} ${c.ord} accion=${c.accion} medidor=${c.medidor} cuenta=${c.cuenta} -> ${c.answer}`).join('\n'));
  expect(cmds.some(c => /Registrada/i.test(c.answer)),
    'JASEC ACCEPTED a command for an invented meter - stop and tell the team').toBe(false);
  expect(cmds.length, `${order}: expected 1 attempt + 3 retries`).toBe(4);
  for (const c of cmds) {
    expect.soft(c.accion, `${c.id}: a SUSPEND must send accion D`).toBe('D');
    expect.soft(c.medidor, `${c.id}: wrong meter on the wire`).toBe(s.meter);
    expect.soft(c.cuenta, `${c.id}: numeroCuenta`).toBe(s.accountId);
    expect.soft(c.answer, `${c.id}: expected JASEC to refuse the invented meter`).toMatch(/No existe/i);
  }
  const st = await orderState(db, order);
  expect(st.status, `${order} after exhausted retries`).toBe('PROVISIONING_ERROR');
  expect.soft(st.retried, `${order} retriedcount`).toBe('3');
  return st;
}

async function openOrders(db: DbHelper, accountId: string): Promise<string> {
  const r = await db.query<{ o: string }>(
    `SELECT coalesce(string_agg(id || ' ' || status, ', '), 'none') AS o FROM core_oms."order"
      WHERE accountid = $1 AND status IN ('CREATED','PENDING')`, [accountId]);
  return r[0]?.o ?? 'none';
}

/**
 * The RESUME half, shared by the full journey and the resume-only test: Resume
 * Order screen -> Submit order -> accion C dispatch -> callback -> ACTIVE.
 */
async function resumeJourney(
  ui: SuspendResumeOrderPage, db: DbHelper, request: APIRequestContext, page: any, testInfo: TestInfo, s: Seeded,
) {
  // ── 4. Resume Order screen ──────────────────────────────────────
  let resumeOrder = '';
  await test.step('4. create the RESUME on the Resume Order screen', async () => {
    const acc = await accountState(db, s);
    blockedIf(acc.sub !== 'SUSPENDED',
      `the subscription is ${acc.sub}, and the Resume Order screen only lists SUSPENDED ones - ` +
      `the suspend half did not leave anything to resume.`);
    await ui.open('resume');
    const listed = await ui.searchAccount(s.accountId);
    await shot(page, testInfo, '4-resume-search');
    blockedIf(!listed,
      `${s.accountId} is not listed on the Resume Order screen. It excludes accounts with an order in ` +
      `CREATED/PENDING, open orders: ${await openOrders(db, s.accountId)}.`);
    await ui.selectAccount(s.accountId);
    if (UNTICK_PARTIAL) await ui.tickOrderOption('Allow Partial Provisioning');
    resumeOrder = await ui.create();
    const toast = resumeOrder ? '' : await ui.lastToastText();
    await shot(page, testInfo, '4-resume-created');
    // A refusal CAUSED BY the stuck suspend is a product result, not a missing
    // precondition: an order that never completes keeps the account "open" and
    // blocks every later order - the reconnection included. Measured on
    // ACT-101076 (ORD-1878) 2026-09-28.
    if (!resumeOrder && /OPEN_ORDER_ALREADY_EXISTS/.test(ui.lastCreateResponse)) {
      const blocking = await db.query<{ id: string; type: string; status: string }>(
        `SELECT id, type, status FROM core_oms."order"
          WHERE accountid = $1 AND status NOT IN ('COMPLETED','CANCELLED') ORDER BY id`, [s.accountId]);
      expect(resumeOrder,
        `The RESUME was refused OPEN_ORDER_ALREADY_EXISTS. Non-terminal orders on ${s.accountId}: ` +
        `${blocking.map(b => `${b.id} ${b.type} ${b.status}`).join(', ') || 'none'}. A SUSPEND whose accepted ` +
        `callback did not complete it leaves the account unable to take ANY new order, so it can never be ` +
        `reconnected from this screen.`).not.toBe('');
    }
    blockedIf(!resumeOrder,
      `CREATE on the Resume Order screen opened no order. Toast: "${toast}". Server answer: ` +
      `${ui.lastCreateResponse.slice(0, 400)} - if it names the balance, resumeRequiresSufficientBalance ` +
      `refused a zero-balance account; record it, it is not a provisioning result.`);
    console.log(`  created ${resumeOrder}`);
    await applyPartialSwitch(ui, db, resumeOrder);
  });

  // ── 5. RESUME dispatch + callback ───────────────────────────────
  await test.step('5. RESUME sends accion C; its callback reactivates and completes', async () => {
    await ui.openOrderDetail(resumeOrder);
    await ui.submitOrder();
    const cmds = await waitForDispatchToSettle(db, resumeOrder);
    console.log(cmds.map(c => `  ${c.id} ${c.ord} accion=${c.accion} medidor=${c.medidor} -> ${c.answer}`).join('\n'));
    expect(cmds.length, `${resumeOrder}: no command reached the AMI`).toBeGreaterThan(0);
    expect(cmds.some(c => /Registrada/i.test(c.answer)), 'JASEC ACCEPTED an invented meter').toBe(false);
    for (const c of cmds) expect(c.accion, `${c.id}: a RESUME must send C - D would cut the power`).toBe('C');

    const body = await postCallback(request, s, resumeOrder, 'RESUME');
    expect(body, 'RESUME callback refused').toContain('FINALIZADO');
    const acc = await waitFor(() => accountState(db, s), a => a.svc === 'ACTIVE');
    expect.soft(acc.svc, 'service unit after the RESUME callback').toBe('ACTIVE');
    expect.soft(acc.sub, 'subscription after the RESUME callback').toBe('ACTIVE');

    const st = await waitFor(() => orderState(db, resumeOrder), o => o.status === 'COMPLETED', 9);
    expect.soft(st.status, `${resumeOrder}: order status after an accepted RESUME callback ` +
      `(service lines ${st.svclines})`).toBe('COMPLETED');
    const onScreen = await ui.readOrderStatus(resumeOrder);
    await shot(page, testInfo, '5-resume-order-after-callback');
    expect.soft(onScreen, `${resumeOrder} status on the order screen`).toBe('COMPLETED');
  });
}

// ── A: the UI journey ────────────────────────────────────────────────────

test.describe('JEPYP-27 - suspend and resume through the Core UI screens', () => {
  test('UI journey: Suspend Order -> callback -> Resume Order -> callback @ui-journey',
    async ({ page, request }, testInfo) => {
      test.skip(!RUN, 'GATED: dispatches to the live AMI. Set JASEC_UI_SUSPEND_RUN=true.');
      test.setTimeout(900_000);
      const logger = new TestLogger('ui-suspend-resume');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) {
        blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`);
      }
      const ui = new SuspendResumeOrderPage(page);

      try {
        await preconditions(db);
        const s = await seedAccount(db, logger, 'QAUISUSP');
        await assertSafeToDispatch(db, s);

        // ── 1. Suspend Order screen ─────────────────────────────────────
        let suspendOrder = '';
        await test.step('1. create the SUSPEND on the Suspend Order screen', async () => {
          await ui.open('suspend');
          const listed = await ui.searchAccount(s.accountId);
          await shot(page, testInfo, '1-suspend-search');
          blockedIf(!listed,
            `${s.accountId} is not listed on the Suspend Order screen. The screen hides accounts whose ` +
            `effective date is after the CCP clock - compare account_search_view.effectivedate with ccp_time.`);
          await ui.selectAccount(s.accountId);
          await ui.chooseSubscriptionReason(REASON);
          if (UNTICK_PARTIAL) await ui.tickOrderOption('Allow Partial Provisioning');
          await shot(page, testInfo, '1-suspend-step2');
          suspendOrder = await ui.create();
          expect(suspendOrder, `CREATE did not open a new order. Toast: "${await ui.lastToastText()}"`).not.toBe('');
          console.log(`  created ${suspendOrder}`);
          await applyPartialSwitch(ui, db, suspendOrder);
          const st = await orderState(db, suspendOrder);
          expect(st.type).toBe('SUSPEND');
          console.log(`  ${suspendOrder}: status ${st.status}, order_services rows ${st.svclines}`);
          expect.soft(st.svclines, 'recorded: the screen sends no services, so 0 service lines is the known shape')
            .toBe('0');
        });

        // ── 2. Submit order -> dispatch ─────────────────────────────────
        await test.step('2. Submit order dispatches a D command, retried 3 times, then stops', async () => {
          await ui.openOrderDetail(suspendOrder);
          await ui.submitOrder();
          await assertSuspendDispatch(db, s, suspendOrder);
          expect.soft(await ui.readOrderStatus(suspendOrder), 'screen status before the callback')
            .toBe('PROVISIONING_ERROR');
          const acc = await accountState(db, s);
          expect.soft(acc.svc, 'a refused dispatch must not suspend the service').toBe('ACTIVE');
        });

        // ── 3. JASEC's callback ─────────────────────────────────────────
        await test.step('3. an accepted SUSPEND callback suspends the account AND completes the order', async () => {
          const body = await postCallback(request, s, suspendOrder, 'SUSPEND');
          expect(body, 'callback refused - nothing downstream can be asserted').toContain('FINALIZADO');

          const acc = await waitFor(() => accountState(db, s), a => a.svc === 'SUSPENDED');
          expect.soft(acc.svc, 'service unit after the SUSPEND callback').toBe('SUSPENDED');
          console.log(`  after SUSPEND callback: subscription ${acc.sub}, service unit ${acc.svc}`);

          // THE DEFECT CHECK. ORD-1869 stayed PROVISIONING_ERROR here.
          const st = await waitFor(() => orderState(db, suspendOrder), o => o.status === 'COMPLETED', 9);
          expect.soft(st.status,
            `${suspendOrder}: the callback was accepted and the account suspended, but the ORDER is ` +
            `${st.status}. Service lines: ${st.svclines}, sequence ${st.seq}.`).toBe('COMPLETED');
          const onScreen = await ui.readOrderStatus(suspendOrder);
          await shot(page, testInfo, '3-suspend-order-after-callback');
          expect.soft(onScreen, `${suspendOrder} status on the order screen after the callback`).toBe('COMPLETED');
        });

        await resumeJourney(ui, db, request, page, testInfo, s);

      } finally {
        await db.disconnect();
      }
    });

  // ── A1: RESUME from the screen, on an account suspended BILLING ONLY ──────
  //
  // The resume half cannot follow a normal UI suspend: that suspend never
  // completes (the defect) and its open order refuses every later order. So
  // the suspend here is ticked "Billing Only" - it should skip the AMI, complete
  // at once and leave the account SUSPENDED with nothing open. That setup is
  // itself unproven on dev (no Billing Only SUSPEND existed before 2026-09-28),
  // so each part of it is asserted and a setup that does not hold is BLOCKED.

  test('UI resume: Billing Only suspend, then Resume Order -> callback @ui-resume-billingonly',
    async ({ page, request }, testInfo) => {
      test.skip(!RUN, 'GATED: dispatches to the live AMI. Set JASEC_UI_SUSPEND_RUN=true.');
      test.setTimeout(900_000);
      const logger = new TestLogger('ui-suspend-resume-resume');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) {
        blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`);
      }
      const ui = new SuspendResumeOrderPage(page);

      try {
        await preconditions(db);
        const s = await seedAccount(db, logger, 'QAUIRES');
        await assertSafeToDispatch(db, s);

        await test.step('0. setup: suspend BILLING ONLY from the Suspend Order screen', async () => {
          await ui.open('suspend');
          blockedIf(!(await ui.searchAccount(s.accountId)),
            `${s.accountId} is not listed on the Suspend Order screen (effective date vs CCP clock?).`);
          await ui.selectAccount(s.accountId);
          await ui.chooseSubscriptionReason(REASON);
          await ui.tickOrderOption('Billing Only');
          await shot(page, testInfo, '0-billing-only-suspend');
          const order = await ui.create();
          expect(order, `CREATE opened no order. Server answer: ${ui.lastCreateResponse.slice(0, 300)}`).not.toBe('');

          // Prove the tick reached the order - an unapplied option and a real
          // result look identical from here on.
          const flag = await db.query<{ b: string; p: string }>(
            `SELECT coalesce(billingonlyflag::text,'') AS b, coalesce(provisioningonlyflag::text,'') AS p
               FROM core_oms."order" WHERE id = $1`, [order]);
          console.log(`  ${order}: billingonlyflag=${flag[0]?.b || '<null>'} provisioningonlyflag=${flag[0]?.p || '<null>'}`);
          expect(flag[0]?.b, `${order}: the Billing Only tick did not reach the order`).toBe('true');

          await ui.openOrderDetail(order);
          await ui.submitOrder();
          const st = await waitFor(() => orderState(db, order), o => o.status === 'COMPLETED', 24);
          const cmds = await commands(db, order);
          const acc = await accountState(db, s);
          console.log(`  billing-only ${order}: order ${st.status}, commands ${cmds.length}, ` +
            `subscription ${acc.sub}, service unit ${acc.svc}`);
          // A command here means the flag was ignored and a real suspend went out -
          // a product result, recorded as a FAIL rather than a missing setup.
          expect.soft(cmds.length, `${order} is Billing Only but dispatched to the AMI`).toBe(0);
          blockedIf(st.status !== 'COMPLETED',
            `the Billing Only suspend ${order} is ${st.status}, not COMPLETED - there is no clean suspended ` +
            `account to resume. (Billing Only on a SUSPEND had never been exercised on dev.)`);
          blockedIf(acc.sub !== 'SUSPENDED' || acc.svc !== 'SUSPENDED',
            `the Billing Only suspend completed but left subscription ${acc.sub} / service unit ${acc.svc}.`);
        });

        await resumeJourney(ui, db, request, page, testInfo, s);
      } finally {
        await db.disconnect();
      }
    });

  // ── A2: the resume half alone, on an account a previous run left suspended ──

  test('UI resume only, on an already-suspended QA account @ui-resume-existing',
    async ({ page, request }, testInfo) => {
      test.skip(!RUN, 'GATED: dispatches to the live AMI. Set JASEC_UI_SUSPEND_RUN=true.');
      const accountId = process.env.JASEC_UI_RESUME_ACCOUNT ?? '';
      blockedIf(!accountId, 'set JASEC_UI_RESUME_ACCOUNT to a SUSPENDED account a previous @ui-journey run seeded.');
      test.setTimeout(600_000);
      const logger = new TestLogger('ui-suspend-resume-resume-only');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) {
        blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`);
      }
      try {
        await preconditions(db);
        const r = await db.query<{ svc: string; sub: string; provid: string; meter: string }>(
          `SELECT su.id AS svc, su.subscriptionid AS sub, su.provisioningid AS provid, sp.provisioningid AS meter
             FROM core_engine.service_unit su
             JOIN core_engine.service_provision sp ON sp.id = su.id AND sp.type = 'METER'
            WHERE su.accountid = $1`, [accountId]);
        blockedIf(r.length !== 1, `${accountId} has ${r.length} metered service units, expected 1.`);
        blockedIf(!r[0].meter.startsWith(METER_PREFIX),
          `${accountId}'s meter ${r[0].meter} was not invented by this spec - refusing to dispatch on it.`);
        const s: Seeded = { accountId, newOrder: '', meter: r[0].meter, svc: r[0].svc, sub: r[0].sub, provId: r[0].provid };
        await assertSafeToDispatch(db, s);
        const ui = new SuspendResumeOrderPage(page);
        await resumeJourney(ui, db, request, page, testInfo, s);
      } finally {
        await db.disconnect();
      }
    });

  // ── B: the control ─────────────────────────────────────────────────────

  test('Control: the same SUSPEND built through the API (with a service line) @api-control',
    async ({ request }) => {
      test.skip(!RUN, 'GATED: dispatches to the live AMI. Set JASEC_UI_SUSPEND_RUN=true.');
      test.setTimeout(600_000);
      blockedIf(!PASS, 'EMBRIX_PASSWORD is not set - the control signs in to create its order.');
      const logger = new TestLogger('ui-suspend-resume-control');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) {
        blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`);
      }

      try {
        await preconditions(db);
        const s = await seedAccount(db, logger, 'QAAPISUSP');
        await assertSafeToDispatch(db, s);

        const login = await (await request.post(TXN, {
          headers: { 'Content-Type': 'application/json' },
          data: { query: `query { userLogin(input:{userName:"${USER}",password:"${PASS}"}){ token } }` },
        })).text();
        const token = login.match(/"token":"([^"]+)"/)?.[1] ?? '';
        blockedIf(!token, `sign-in returned no token: ${login.slice(0, 200)}`);
        const gql = async (url: string, query: string) => (await request.post(url, {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          data: { query }, timeout: 240_000,
        })).text();

        let order = '';
        await test.step('1. createOrder SUSPEND with services[] + reSubmitOrder (the older specs\' shape)', async () => {
          const created = await gql(TXN,
            `mutation { createOrder(input:{type: SUSPEND, accountId: "${s.accountId}", userId: "${USER}", ` +
            `subscriptionReason: ${REASON}, services:[{index:1, serviceType: ELECTRICITY, action: SUSPEND, ` +
            `provisioningId: "${s.provId}", bundleId: "B-100000-E"}]}){ id status } }`);
          order = created.match(/"id":"(ORD-[0-9]+)"/)?.[1] ?? '';
          expect(order, `createOrder returned no id: ${created.slice(0, 300)}`).not.toBe('');
          await gql(CRM, `mutation { reSubmitOrder(input:{id: "${order}"}){ id status } }`);
          const st = await orderState(db, order);
          console.log(`  created ${order}: status ${st.status}, order_services rows ${st.svclines}`);
          expect(st.svclines, 'the control must carry a service line - that is the variable').not.toBe('0');
        });

        await test.step('2. dispatch: 4 refused D commands', async () => {
          await assertSuspendDispatch(db, s, order);
        });

        await test.step('3. accepted callback completes the order', async () => {
          const body = await postCallback(request, s, order, 'SUSPEND');
          expect(body, 'callback refused').toContain('FINALIZADO');
          const st = await waitFor(() => orderState(db, order), o => o.status === 'COMPLETED', 9);
          const acc = await accountState(db, s);
          console.log(`  control ${order}: order ${st.status}, subscription ${acc.sub}, service unit ${acc.svc}`);
          expect.soft(st.status, `control ${order} order status after the callback`).toBe('COMPLETED');
          expect.soft(acc.svc, 'control service unit').toBe('SUSPENDED');
        });
      } finally {
        await db.disconnect();
      }
    });
});
