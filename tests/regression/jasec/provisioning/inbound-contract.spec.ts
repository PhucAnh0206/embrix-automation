/**
 * The inbound half of JASEC provisioning: our updateProvisioningRequest endpoint.
 *
 * WHAT THE FLOW IS. Suspend and reconnect is a two-way conversation. We post a
 * SOAP command to JASEC's AMI carrying the meter, an action code, our order
 * number and the account number; they answer 00 meaning QUEUED, and our order
 * sits in PROVISIONING_INITIATED. Later their field system acts on the meter and
 * THEIR system calls this endpoint to close the order. Neither half finishes it
 * alone, and we cannot trigger the inbound half ourselves.
 *
 * WHY ONLY NEGATIVE CASES HERE. Closing an order requires one sitting in
 * PROVISIONING_INITIATED, and an order only reaches that state when JASEC ACCEPT
 * a dispatched command - which needs a meter they recognise, of which only
 * 339400 and 324030 are known to work, and both are contended. Creating an
 * account with our own automation does NOT produce one: our accounts carry
 * prov-ACT-nnn meters, JASEC reject those, and the order lands in
 * PROVISIONING_ERROR instead. Three orders are staged for sessions right now
 * (ORD-1059, ORD-1322, ORD-1323, ORD-1381) and this spec must never touch them.
 *
 * So every case below is a REFUSAL, which needs no fixture at all. The two happy
 * paths stay manual session work until we are given a spare meter.
 *
 * SAFETY. Every payload names either an order id that cannot exist, or ORD-960,
 * which is COMPLETED and therefore terminal - a callback on it is refused by
 * design and changes nothing. Nothing here can complete, cancel or advance a
 * real order. If a case ever reports SUCCESS, that itself is the failure.
 *
 * VALIDATION ORDER, established by probing on 2026-08-30. It matters, because it
 * decides which cases are reachable:
 *
 *   1. deserialize the body      malformed enum fails here, before any lookup
 *   2. order exists              "Order id given in Payload does not exist"
 *   3. order state               "Order already Completed/Cancelled"
 *   4. payload shape             only reached for an order in a valid state
 *
 * Step 4 is why "missing services" and "wrong serviceType" are NOT covered here:
 * they are unreachable without a live order, and a test that cannot distinguish
 * its outcome from the state check proves nothing.
 *
 * THE ENDPOINT ANSWERS HTTP 200 ON FAILURE. The verdict lives in the body's
 * `status` field, exactly like the PlaceToPay verify call in the top-up suite.
 * Asserting on the HTTP code would pass on every single one of these.
 */

import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';

// Follows TEST_ENV. This defaulted to a hardcoded jasec-dev host, so a preprod
// run posted callbacks at DEV's gateway while believing it was testing preprod -
// the same defect found in dispatch.spec.ts on 2026-09-15, where it raised an
// order on the wrong tenant (ORD-1582). Account ids collide across tenants, so
// nothing looks wrong when this happens; it has to be prevented, not spotted.
const TENANT = (process.env.TEST_ENV ?? 'jasec-dev').trim();
if (!/^jasec-(dev|preprod)$/.test(TENANT)) {
  throw new Error(
    `inbound-contract.spec: TEST_ENV must be jasec-dev or jasec-preprod (got '${TENANT}').`,
  );
}
const ENDPOINT =
  process.env.JASEC_PROVISION_CALLBACK_URL ??
  `https://provision-gateway.${TENANT}.embrix.org/updateProvisioningRequest`;

/**
 * Orders staged for a JASEC session. Never name one of these in a payload - a
 * valid callback would CLOSE it, and each order can be closed exactly once.
 * Kept as a guard: the helper below refuses to send a payload naming one.
 */
const DO_NOT_TOUCH = ['ORD-1059', 'ORD-1322', 'ORD-1323', 'ORD-1381'];

/**
 * COMPLETED and therefore terminal. A callback on it is refused by design.
 *
 * PER-TENANT, because order ids do not line up across tenants. The default pair
 * is the dev one; preprod's equivalent is ORD-77 / ACT-100051, a SUSPEND order
 * this suite raised and JASEC's callback closed on 2026-09-15.
 *
 * Override with JASEC_TERMINAL_ORDER / JASEC_TERMINAL_ACCOUNT. Whatever you
 * pass MUST already be COMPLETED or CANCELLED - the whole point is that a
 * callback on it cannot change anything. Never point this at a live order, and
 * never at one staged for a JASEC session (see DO_NOT_TOUCH).
 */
const TERMINAL_DEFAULTS: Record<string, { orderId: string; accountId: string }> = {
  'jasec-dev': { orderId: 'ORD-960', accountId: 'AC-990001' },
  // SUSPEND, COMPLETED, completeddate 2026-09-14. Verified terminal 2026-09-16.
  // Wiring this closed three cases that had reported BLOCKED on preprod since
  // 2026-09-15: the fixture existed the whole time and the default was dev's.
  // Same class of fault as FIRST_V5_INVOICE and BILLING_FIX_CUTOFF.
  'jasec-preprod': { orderId: 'ORD-77', accountId: 'ACT-100051' },
};
const TERMINAL_ORDER: { orderId: string; accountId: string } = {
  orderId: process.env.JASEC_TERMINAL_ORDER ?? TERMINAL_DEFAULTS[TENANT].orderId,
  accountId: process.env.JASEC_TERMINAL_ACCOUNT ?? TERMINAL_DEFAULTS[TENANT].accountId,
};

/**
 * PROVE it is terminal before posting anything at it.
 *
 * The note above says whatever is configured MUST already be COMPLETED or
 * CANCELLED, and until now that was enforced by nothing. If it ever names a LIVE
 * order, a valid callback would CLOSE it - the single outcome this spec exists
 * to avoid, and it cannot be undone. DO_NOT_TOUCH does not help: every id on it
 * is a dev id, so on preprod it is inert.
 *
 * The risk rose on 2026-09-16. While Bug_019 was open preprod could not reach
 * JASEC at all; now it authenticates, so a mutated order there is real.
 *
 * Fails CLOSED: if the status cannot be read, the cases BLOCK rather than post.
 */
const TERMINAL_STATES = ['COMPLETED', 'CANCELLED'];
let terminalGuard: string | null = 'the terminal-order guard did not run';

async function checkTerminal(): Promise<void> {
  const db = new DbHelper();
  try {
    await db.connect();
    const rows = await db.query<{ id: string; type: string; status: string }>(
      'SELECT id, type, status FROM core_oms.order WHERE id = $1',
      [TERMINAL_ORDER.orderId],
    );
    // The fallback runs when the configured subject is UNUSABLE, which means
    // absent OR present-but-not-terminal (widened 2026-09-17).
    //
    // It used to run only on absent. After the first live dispatch on preprod,
    // ORD-77 came into existence as SUSPEND/PROVISIONING_ERROR - a real order,
    // not terminal - so the fallback was skipped and all three cases BLOCKED,
    // even though the same dispatch had just created ORD-81 SUSPEND/COMPLETED,
    // exactly the subject they wanted. Absent and unusable are the same problem
    // and deserve the same recovery; only 'no terminal order exists anywhere'
    // is a real block.
    const configuredOk = rows.length > 0 && TERMINAL_STATES.includes(rows[0].status);
    if (configuredOk) { terminalGuard = null; return; }
    {
      // WIPE-PROOFING (2026-09-16). The configured id is a convenience, not a
      // requirement: after a tenant data wipe it will not exist, and three cases
      // would block forever on a fixture that is trivially re-derivable.
      //
      // So fall back to ANY genuinely terminal SUSPEND order on this tenant.
      // Same safety bar as the configured one - COMPLETED or CANCELLED only, and
      // never anything on DO_NOT_TOUCH - so the fallback cannot widen the blast
      // radius. Newest first, because a recently closed order is the least
      // likely to be part of someone's staged session.
      const fallback = await db.query<{ id: string; accountid: string; status: string }>(
        `SELECT id, accountid, status
           FROM core_oms.order
          -- Type is a PREFERENCE, not a filter (widened 2026-09-17). These three
          -- cases assert that the STATE check fires FIRST - the RESUME case
          -- deliberately names an action that does NOT match the order's type in
          -- order to prove exactly that. So any terminal order satisfies them.
          --
          -- Requiring SUSPEND blocked all three on the rebuilt preprod, whose
          -- core_oms.order held only NEW (40) and RENEW (25): nothing had ever
          -- been suspended there. Creating one is NOT a cheap fix - 11 of 13
          -- SUSPEND orders on dev each dispatched 4 real commands to JASEC's
          -- live AMI, so the fixture would have cost a client-facing dispatch.
          WHERE status = ANY($1)
            AND id <> ALL($2)
          -- Order by completion, NOT by a number parsed out of the id. Preprod
          -- carries both ORD-nnn and OR-nnn ids, and a template literal collapses
          -- a lone backslash, so the regexp arrived as 'D' and the cast blew up on
          -- 'OR-77'. completeddate is what "most recently closed" actually means.
          ORDER BY (type = 'SUSPEND') DESC, completeddate DESC NULLS LAST, id DESC
          LIMIT 1`,
        [TERMINAL_STATES, DO_NOT_TOUCH],
      );
      if (fallback.length === 0) {
        // Nothing terminal exists at all. blockIfOrderAbsent reports it per case
        // with the seeding instructions - a better message than anything here.
        terminalGuard = null;
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        `
  ${TERMINAL_ORDER.orderId} is not a usable terminal order on ${TENANT}; using `
        + `${fallback[0].id} (${fallback[0].status}) instead.
`,
      );
      TERMINAL_ORDER.orderId = fallback[0].id;
      TERMINAL_ORDER.accountId = fallback[0].accountid;
      terminalGuard = null;
      return;
    }
  } catch (e) {
    terminalGuard =
      `could not read ${TERMINAL_ORDER.orderId} on ${TENANT} (${(e as Error).message}). `
      + 'Refusing to post a callback at an order whose state is unknown.';
  } finally {
    await db.disconnect().catch(() => undefined);
  }
}

test.beforeAll(async () => {
  await checkTerminal();
});

/** Returns true if the case must stop. Call before any terminal-order post. */
function blockIfNotTerminal(what: string): boolean {
  if (terminalGuard === null) return false;
  // eslint-disable-next-line no-console
  console.log(`
  BLOCKED, not failed: ${what} - ${terminalGuard}
`);
  test.skip(true, `BLOCKED, not failed: ${terminalGuard}`);
  return true;
}

/**
 * TERMINAL_ORDER IS A DEV ORDER. It has to be a real, already-closed order, so
 * it cannot be synthesised - and order ids do not line up across tenants:
 * jasec-dev is past ORD-1500 while jasec-preprod restarted near ORD-70 after
 * its rebuild, and preprod has never raised a SUSPEND order at all.
 *
 * On preprod the endpoint therefore answers 'Order id given in Payload does not
 * exist in Embrix' and three cases FAILED (2026-09-15) - reporting a missing
 * fixture as though the refusal contract were broken. It is not: the contract
 * was never exercised, because there was nothing to exercise it against.
 *
 * So detect that answer and report BLOCKED. Do NOT swap in a preprod order id
 * here - it must be one that is genuinely terminal, and picking a live one
 * would make this spec mutate state it is supposed to only probe.
 */
const ABSENT = /does not exist in Embrix/i;
function blockIfOrderAbsent(r: { errorMsg?: string }, what: string): boolean {
  if (!ABSENT.test(r.errorMsg ?? '')) return false;
  const why =
    `${what} needs a real already-closed order, and ${TERMINAL_ORDER.orderId} does not ` +
    `exist on this tenant (${TENANT}). Seed a terminal SUSPEND order here, or run this ` +
    `case on the tenant that has one.`;
  // eslint-disable-next-line no-console
  console.log(`
  BLOCKED, not failed: ${why}
`);
  test.skip(true, `BLOCKED, not failed: ${why}`);
  return true;
}

/** Cannot match anything. Suffixed per-run so two runs never collide. */
const absentOrder = (tag: string) => `ORD-QA-ABSENT-${tag}-${Date.now()}`;

type CallbackResult = {
  httpStatus: number;
  status?: string;
  errorCode?: string;
  errorMsg?: string;
  raw: string;
};

async function callback(
  request: import('@playwright/test').APIRequestContext,
  body: unknown,
): Promise<CallbackResult> {
  const named = JSON.stringify(body ?? {});
  for (const staged of DO_NOT_TOUCH) {
    if (named.includes(staged)) {
      throw new Error(
        `Refusing to send: the payload names ${staged}, which is staged for a JASEC ` +
        `session. Closing it would spend an order that cannot be reopened.`,
      );
    }
  }
  const res = await request.post(ENDPOINT, {
    headers: { 'content-type': 'application/json' },
    data: body as Record<string, unknown>,
    failOnStatusCode: false,
  });
  const raw = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* not JSON - raw carries it */
  }
  return {
    httpStatus: res.status(),
    status: parsed.status as string | undefined,
    errorCode: parsed.errorCode as string | undefined,
    errorMsg: parsed.errorMsg as string | undefined,
    raw,
  };
}

/** Every case here must be refused. Shared so the intent reads once. */
function expectRefused(r: CallbackResult, what: string) {
  expect(
    r.status,
    `${what}: expected the callback to be REFUSED, but the endpoint answered ` +
    `status=${r.status}. If this now succeeds, either the contract changed or ` +
    `this payload reached a real order. Body: ${r.raw.slice(0, 300)}`,
  ).toBe('FAILED');
}

test.describe('JASEC provisioning - inbound callback contract', () => {
  test('the endpoint answers HTTP 200 even when it refuses', async ({ request }) => {
    // Cross-cutting, and the reason every other assertion reads the body. A
    // suite that checked res.ok() would pass on every refusal in this file.
    const r = await callback(request, {
      orderId: absentOrder('http'),
      accountId: 'QA-NONE',
      status: 'COMPLETED',
      services: [],
    });
    expect(
      r.httpStatus,
      'The endpoint is expected to answer 200 and carry the verdict in the body. ' +
      'If it starts answering 4xx/5xx that is a contract change worth knowing about, ' +
      'not necessarily a defect.',
    ).toBe(200);
    expectRefused(r, 'absent order');
  });

  test('an order id that does not exist is refused', async ({ request }) => {
    const r = await callback(request, {
      orderId: absentOrder('unknown'),
      accountId: 'QA-NONE',
      status: 'COMPLETED',
      services: [
        { serviceType: 'ELECTRICITY', action: 'SUSPEND', bundleId: 'NONE', provisioningId: '000000' },
      ],
    });
    expectRefused(r, 'unknown order');
    expect(r.errorCode).toBe('INCORRECT_INPUT');
    expect(r.errorMsg).toContain('does not exist');
  });

  test('targetId instead of orderId is refused, not crashed', async ({ request }) => {
    // The runbook calls this out as a repeat cause of confusion: the field is
    // orderId, not targetId. Confirms it degrades to the ordinary "does not
    // exist" refusal rather than throwing - the response even echoes targetId
    // back, which is where the confusion comes from.
    const r = await callback(request, {
      targetId: TERMINAL_ORDER.orderId,
      accountId: TERMINAL_ORDER.accountId,
      status: 'COMPLETED',
      services: [
        { serviceType: 'ELECTRICITY', action: 'SUSPEND', bundleId: 'NONE', provisioningId: '339400' },
      ],
    });
    expectRefused(r, 'targetId instead of orderId');
    expect(r.errorCode).toBe('INCORRECT_INPUT');
    expect(r.errorMsg).toContain('does not exist');
  });

  test('an omitted order id is refused, not crashed', async ({ request }) => {
    const r = await callback(request, {
      accountId: 'QA-NONE',
      status: 'COMPLETED',
      services: [],
    });
    expectRefused(r, 'omitted order id');
    expect(r.errorCode).toBe('INCORRECT_INPUT');
    expect(r.errorMsg).toContain('does not exist');
  });

  test('a second callback on an already-closed order is refused', async ({ request }) => {
    // The documented single-use rule: once an order is COMPLETED a further call
    // is refused by design. This is the one case that names a real order, and it
    // is safe precisely because that order is terminal.
    if (blockIfNotTerminal('already-closed order')) return;
    const r = await callback(request, {
      orderId: TERMINAL_ORDER.orderId,
      accountId: TERMINAL_ORDER.accountId,
      status: 'COMPLETED',
      services: [
        { serviceType: 'ELECTRICITY', action: 'SUSPEND', bundleId: 'NONE', provisioningId: '339400' },
      ],
    });
    if (blockIfOrderAbsent(r, 'already-closed order')) return;
    expectRefused(r, 'already-closed order');
    expect(r.errorCode).toBe('INCORRECT_INPUT');
    expect(r.errorMsg).toMatch(/already Completed|Cancelled/i);
  });

  test('order state is checked before payload shape', async ({ request }) => {
    // Same terminal order, but with the services array missing entirely. It is
    // still refused for STATE, not for the missing array - which is why the
    // shape cases are not covered in this file. Documents the ordering so nobody
    // writes a shape test that silently asserts the state check instead.
    if (blockIfNotTerminal('terminal order, no services')) return;
    const r = await callback(request, {
      orderId: TERMINAL_ORDER.orderId,
      accountId: TERMINAL_ORDER.accountId,
      status: 'COMPLETED',
    });
    if (blockIfOrderAbsent(r, 'terminal order, no services')) return;
    expectRefused(r, 'terminal order, no services');
    expect(
      r.errorMsg,
      'Expected the STATE check to answer first. If this now reports a missing ' +
      'services array instead, the validation order changed and the shape cases ' +
      'in the plan become reachable - which would be good news, see ' +
      'notes/JASEC_provisioning-test-plan.md',
    ).toMatch(/already Completed|Cancelled/i);
  });

  test('a status value outside the enum fails at deserialization', async ({ request }) => {
    const r = await callback(request, {
      orderId: TERMINAL_ORDER.orderId,
      accountId: TERMINAL_ORDER.accountId,
      status: 'NOT_A_STATUS',
      services: [
        { serviceType: 'ELECTRICITY', action: 'SUSPEND', bundleId: 'NONE', provisioningId: '339400' },
      ],
    });
    expectRefused(r, 'malformed status enum');
    // SYSTEM_ERROR rather than INCORRECT_INPUT: this fails while parsing the
    // body, before any order lookup happens.
    expect(r.errorCode).toBe('SYSTEM_ERROR');
    expect(r.errorMsg).toContain('OrderStatus');
  });

  // ── RESUME ────────────────────────────────────────────────────────────
  //
  // Everything above is SUSPEND-shaped. Reconnect travels the same endpoint with
  // action RESUME, and the refusal paths should not care which it is - validation
  // runs deserialize, existence, state, and only then shape, so the action value
  // is never reached on a refusal. That is worth CONFIRMING rather than assuming:
  // if a RESUME callback ever refuses differently from a SUSPEND one, the two
  // paths have diverged somewhere they should not have.

  test('RESUME: an order id that does not exist is refused identically', async ({ request }) => {
    const suspend = await callback(request, {
      orderId: absentOrder('cmp-s'),
      accountId: 'QA-NONE',
      status: 'COMPLETED',
      services: [
        { serviceType: 'ELECTRICITY', action: 'SUSPEND', bundleId: 'NONE', provisioningId: '000000' },
      ],
    });
    const resume = await callback(request, {
      orderId: absentOrder('cmp-r'),
      accountId: 'QA-NONE',
      status: 'COMPLETED',
      services: [
        { serviceType: 'ELECTRICITY', action: 'RESUME', bundleId: 'NONE', provisioningId: '000000' },
      ],
    });

    expectRefused(resume, 'RESUME, unknown order');
    expect(resume.errorCode).toBe('INCORRECT_INPUT');
    expect(resume.errorMsg).toContain('does not exist');

    // The point of the case: same treatment, not merely a valid-looking refusal.
    expect(
      resume.errorMsg,
      `RESUME refused differently from SUSPEND for the same condition. ` +
      `SUSPEND said "${suspend.errorMsg}", RESUME said "${resume.errorMsg}". ` +
      `The refusal paths are supposed to be action-agnostic - validation reaches ` +
      `existence long before it looks at the action.`,
    ).toBe(suspend.errorMsg);
  });

  test('RESUME: a second callback on an already-closed order is refused', async ({ request }) => {
    if (blockIfNotTerminal('RESUME on an already-closed SUSPEND order')) return;
    const r = await callback(request, {
      orderId: TERMINAL_ORDER.orderId,
      accountId: TERMINAL_ORDER.accountId,
      status: 'COMPLETED',
      services: [
        { serviceType: 'ELECTRICITY', action: 'RESUME', bundleId: 'NONE', provisioningId: '339400' },
      ],
    });
    // A RESUME callback naming a terminal order is refused for STATE - the order
    // is terminal - which confirms the state check does not depend on the action
    // matching the order's type. That is the WHOLE point, so the subject need not
    // be a SUSPEND order: on a tenant that has never suspended anything it is a
    // terminal NEW order, which tests the property at least as strongly.
    if (blockIfOrderAbsent(r, 'RESUME on an already-closed SUSPEND order')) return;
    expectRefused(r, 'RESUME on an already-closed SUSPEND order');
    expect(r.errorCode).toBe('INCORRECT_INPUT');
    expect(r.errorMsg).toMatch(/already Completed|Cancelled/i);
  });

  test('an empty body is refused with a validation message, not a crash', async ({ request }) => {
    // WAS A DEFECT, now FIXED and verified. Until 2026-09-04 an empty JSON
    // object produced "Cannot get property 'id' on null object" - a crash
    // rather than a validation message, because validateProvisioningUpdatePayload
    // read order.id before checking an order had been resolved at all.
    //
    // Fixed in edb6473 on feature/jasec-integration. Confirmed live on
    // jasec-dev after the provision-gateway pod restarted 2026-09-04 14:29Z:
    // this case failed on the old assertion and the new message came back
    // exactly as the team described it.
    //
    // The team say the same guard is on all three inbound routes, and that a
    // callback carrying a real order behaves exactly as before - which the
    // cases above this one are what prove.
    const r = await callback(request, {});
    expectRefused(r, 'empty body');
    expect(
      r.errorMsg,
      'Expected the validation message introduced by edb6473. If a null-pointer ' +
      'is back, the fix has been reverted or jasec-dev has been rolled onto an ' +
      'image that predates it - check the running image before re-filing.',
    ).toMatch(/Payload is empty or no field matched|OrderId can not be empty/i);
    expect(r.errorMsg).not.toContain("Cannot get property 'id' on null object");
  });
});
