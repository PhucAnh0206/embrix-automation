/**
 * EXPLORATORY - NOT an official case (no TC number, not in INDEX, not in any runner) until the team answers F7.
 *
 * Question (F7, prod build 2, 2026-10-05): once a RESUME order has failed (PROVISIONING_ERROR - AMI down, meter
 * comms error), does a LATER top-up raise a NEW RESUME, or does the customer stay cut off although they paid?
 * Seen on ACT-100110: RESUME ORD-189 failed 10-02; two later top-ups (RENEW ORD-194/195) raised no RESUME, the
 * subscription stayed SUSPENDED. Control ACT-100115 (same state, no earlier RESUME) DID raise one.
 *
 * Design - ONE fresh account, which is its own control:
 *   1. seed, billing-only SUSPEND (sends nothing to the AMI - asserted), stage 1500 CRC debt
 *   2. top-up #1 clears the debt  -> a RESUME must be raised (CONTROL). The AMI refuses QA meters, so it ends
 *      PROVISIONING_ERROR - that is the stuck order F7 needs. Anything else = BLOCKED (precondition not built).
 *   3. top-up #2 (customer pays again) -> is a NEW RESUME raised?  yes = no F7;  no = F7 reproduced.
 * Asserts only the harness (control raised a RESUME, top-up #2 was applied). The answer is recorded in the report
 * and as an annotation - whether manual reprocess is the INTENDED recovery is the open team question.
 *
 * MUTATING: seeds 1 account, 2 top-ups, raises RESUME orders that reach JASEC's AMI (refused for a QA meter - the
 * same thing TC-82 does). No clock move, no job runs. dev / preprod / prod TEST builds.
 *   $env:JASEC_F7_RUN='true'; npx playwright test --project=jasec-billing-explore --grep "@stuck-resume"
 */
import { test, expect } from '@playwright/test';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { DbHelper, hasDbConfig } from '../../../../helpers/db.helper';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN = String(process.env.JASEC_F7_RUN ?? '').trim().toLowerCase() === 'true';
const ALLOWED = ['jasec-dev', 'jasec-preprod', 'jasec'].includes(process.env.TEST_ENV ?? '');
const DEBT = 1500;
const TOP_UP_1 = 1700; // clears the debt: balance -200 (credit, inverted sign)
const TOP_UP_2 = 500;  // the customer pays again: balance -700
const IN_FLIGHT = ['CREATED', 'SUBMITTED', 'PROCESSING', 'APPROVED', 'PROVISIONING_INITIATED'];

test('a failed RESUME must not block the next reconnect (F7, exploratory) @stuck-resume', async () => {
  if (blockedIf(!RUN, 'JASEC_F7_RUN is not "true" - this seeds, tops up and raises RESUME orders')) return;
  if (blockedIf(!ALLOWED, `dev / preprod / prod test builds only (TEST_ENV=${process.env.TEST_ENV})`)) return;
  if (blockedIf(!hasDbConfig(), 'needs DB access')) return;
  test.setTimeout(900_000);

  const seed = new PrepaidSeedHelper();
  const db = new DbHelper();
  await db.connect();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const subStatus = async (a: string) =>
    (await db.query<{ status: string }>(
      `SELECT status FROM core_engine.subscription WHERE accountid = $1 ORDER BY createddate DESC LIMIT 1`, [a]))[0]?.status ?? '';
  const resumes = async (a: string) =>
    db.query<{ id: string; status: string }>(
      `SELECT id, status FROM core_oms."order" WHERE accountid = $1 AND type = 'RESUME'
        ORDER BY (regexp_replace(id, '[^0-9]', '', 'g'))::bigint`, [a]);
  const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number): Promise<T> => {
    let v = await read();
    for (const end = Date.now() + ms; !done(v) && Date.now() < end; v = await read()) await wait(5_000);
    return v;
  };

  try {
    // 1. Own subject, suspended billing-only, in debt.
    const s = uniqueRunSuffix();
    const meter = assertQaMeter(`M-QASTUCK-${s}`);
    const { accountId } = await seed.seed({ meter, customerId: `E2ESTUCK-${s}`, name: `E2ESTUCK ${s}` });
    await until(() => subStatus(accountId), v => v === 'ACTIVE', 60_000);
    // Resolved while ACTIVE (the lookup only sees ACTIVE). Debt is staged only AFTER the suspend:
    // debt on an ACTIVE account could trigger a REAL balance suspension, which does reach the AMI.
    const bu = await db.getBalanceUnitIdForAccount(accountId);
    const suspend = await seed.suspendAccountBillingOnly(accountId);
    const st = await until(() => subStatus(accountId), v => v === 'SUSPENDED', 60_000);
    if (blockedIf(st !== 'SUSPENDED', `${accountId}: billing-only SUSPEND ${suspend} left it ${st}`)) return;
    const ami = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core_engine.activity WHERE accountid = $1 AND apiname ILIKE '%UTILITIES%'`, [accountId]);
    expect(ami[0].n, `billing-only SUSPEND ${suspend} must send nothing to the AMI`).toBe(0);
    await db.setBalanceAmount(bu, DEBT);
    console.log(`\n[F7] ${accountId} (meter ${meter}): SUSPEND ${suspend} (billing only, 0 AMI), debt ${DEBT}`);

    // 2. CONTROL: top-up #1 clears the debt -> a RESUME is raised and (QA meter) fails.
    await seed.topUp(accountId, TOP_UP_1);
    const first = await until(() => resumes(accountId),
      r => r.length > 0 && !IN_FLIGHT.includes(r[0].status), 300_000);
    console.log(`[F7] top-up #1 ${TOP_UP_1}: balance ${await db.getBalanceAmount(bu)} | RESUME ` +
      (first.map(r => `${r.id} ${r.status}`).join(', ') || 'none') + ` | subscription ${await subStatus(accountId)}`);
    if (blockedIf(first.length === 0,
      `CONTROL failed: clearing the debt raised no RESUME on ${accountId} within 5 min, so F7 cannot be judged ` +
      '(top-up path or reconnect gate differs here - compare with TC-82)')) return;
    if (blockedIf(first[0].status !== 'PROVISIONING_ERROR',
      `the first RESUME ${first[0].id} ended ${first[0].status}, not PROVISIONING_ERROR - no stuck order to test ` +
      '(on a tenant whose AMI accepts the meter, F7 needs a real comms failure)')) return;

    // 3. The customer pays again while that RESUME sits in PROVISIONING_ERROR.
    const before = Number(await db.getBalanceAmount(bu));
    await seed.topUp(accountId, TOP_UP_2);
    const after = await until(async () => Number(await db.getBalanceAmount(bu)), v => v !== before, 120_000);
    expect(after, `top-up #2 (${TOP_UP_2}) must be applied - balance stayed ${before}`).toBeCloseTo(before - TOP_UP_2, 2);
    // Same window the control was given, so "none" is not just impatience.
    const second = await until(() => resumes(accountId), r => r.length > first.length, 300_000);
    const raised = second.slice(first.length);
    const status = await subStatus(accountId);
    const reproduced = raised.length === 0;
    console.log(`[F7] top-up #2 ${TOP_UP_2}: balance ${before} -> ${after} | new RESUME ` +
      (raised.map(r => `${r.id} ${r.status}`).join(', ') || 'NONE in 5 min') + ` | subscription ${status}`);
    console.log(reproduced
      ? `[F7] REPRODUCED: ${accountId} paid twice and stays ${status}; the only RESUME is ${first[0].id} ` +
        `(PROVISIONING_ERROR). Recovery is a manual reprocess of that order.\n`
      : `[F7] NOT reproduced: top-up #2 raised ${raised[0].id} - a stuck RESUME does not block reconnects here.\n`);
    test.info().annotations.push(
      { type: 'finding', description: reproduced ? `F7 reproduced on ${accountId} (${first[0].id})` : `F7 not reproduced on ${accountId}` },
      { type: 'decision-pending', description: 'is manual reprocess of the failed RESUME the intended recovery? (pick-up B7 / D5)' },
    );
  } finally {
    await db.disconnect();
  }
});
