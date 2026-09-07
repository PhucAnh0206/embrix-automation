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
 * (ORD-1059, ORD-1322, ORD-1323) and this spec must never touch them.
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

const ENDPOINT =
  process.env.JASEC_PROVISION_CALLBACK_URL ??
  'https://provision-gateway.jasec-dev.embrix.org/updateProvisioningRequest';

/**
 * Orders staged for a JASEC session. Never name one of these in a payload - a
 * valid callback would CLOSE it, and each order can be closed exactly once.
 * Kept as a guard: the helper below refuses to send a payload naming one.
 */
const DO_NOT_TOUCH = ['ORD-1059', 'ORD-1322', 'ORD-1323'];

/** COMPLETED and therefore terminal. A callback on it is refused by design. */
const TERMINAL_ORDER = { orderId: 'ORD-960', accountId: 'AC-990001' };

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
    const r = await callback(request, {
      orderId: TERMINAL_ORDER.orderId,
      accountId: TERMINAL_ORDER.accountId,
      status: 'COMPLETED',
      services: [
        { serviceType: 'ELECTRICITY', action: 'SUSPEND', bundleId: 'NONE', provisioningId: '339400' },
      ],
    });
    expectRefused(r, 'already-closed order');
    expect(r.errorCode).toBe('INCORRECT_INPUT');
    expect(r.errorMsg).toMatch(/already Completed|Cancelled/i);
  });

  test('order state is checked before payload shape', async ({ request }) => {
    // Same terminal order, but with the services array missing entirely. It is
    // still refused for STATE, not for the missing array - which is why the
    // shape cases are not covered in this file. Documents the ordering so nobody
    // writes a shape test that silently asserts the state check instead.
    const r = await callback(request, {
      orderId: TERMINAL_ORDER.orderId,
      accountId: TERMINAL_ORDER.accountId,
      status: 'COMPLETED',
    });
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
    const r = await callback(request, {
      orderId: TERMINAL_ORDER.orderId,
      accountId: TERMINAL_ORDER.accountId,
      status: 'COMPLETED',
      services: [
        { serviceType: 'ELECTRICITY', action: 'RESUME', bundleId: 'NONE', provisioningId: '339400' },
      ],
    });
    // ORD-960 was a SUSPEND. A RESUME callback naming it is still refused for
    // STATE - the order is terminal - which confirms the state check does not
    // depend on the action matching either.
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
