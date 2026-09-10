/**
 * Provisioning: the manual reprocess, through the UI - which is what the ticket asks
 * for. "If max retries is reached, then stop, the UI need to be able to
 * reprocess manually."
 *
 * WHY THIS IS THE ONLY TEST FOR THAT REQUIREMENT. The UI path is a strict
 * superset of the API path: button -> updateOrderStatus -> OMS queue ->
 * PGOmsService.submitOrder -> provisioning sequence re-runs -> command
 * dispatched. If this passes, the API underneath necessarily worked, so a
 * separate API test would add no coverage - only a second command to JASEC on
 * every run. The assertions below are deliberately granular so a red result
 * still says WHERE it broke: button missing, button disabled, or no dispatch.
 *
 * WHAT "PASS" LOOKS LIKE, because it reads like a failure. On an order whose
 * meter JASEC reject, the correct outcome is:
 *
 *     click -> status flicks to SUBMITTED -> a command is dispatched ->
 *     JASEC answer "El Medidor No existe" -> the order returns to
 *     PROVISIONING_ERROR carrying that reason
 *
 * So the order ending back at PROVISIONING_ERROR is the SUCCESS state here, and
 * the reason text is JASEC's answer to the command that was just sent. The
 * status does NOT stay SUBMITTED, so this spec deliberately does not assert
 * that - it asserts the DISPATCH, which is the thing that actually matters.
 * On a meter they accept it would instead settle at PROVISIONING_INITIATED
 * awaiting the callback.
 *
 * SUBJECT MATTERS. executeOrderProvSequences filters the order's services to
 * those with no status, PROVISIONING_INITIATED or CREATED, and returns early if
 * none survive. An order whose service line is already COMPLETED short circuits
 * before the sequence loop, so pressing Submit there proves nothing either way.
 * This spec refuses such an order rather than reporting a misleading pass.
 *
 * PERMISSION. The button is gated on SUBMIT_ORDER, which some roles hold as
 * READ_ONLY - that renders it disabled, which looks exactly like the feature not
 * being built. The enabled assertion below distinguishes those two.
 *
 * GATED: dispatches to JASEC's live AMI (one command - a reprocessed order gets
 * a single attempt, no retries, because retriedcount is not reset).
 *
 *   JASEC_UI_REPROCESS_RUN=true
 *   JASEC_UI_REPROCESS_ORDER=ORD-nnnn
 *
 * Verified by hand on ORD-1058 on 2026-09-07: 4 commands before, 5 after,
 * A-104194 accion D medidor 324451.
 */

import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';

const RUN = process.env.JASEC_UI_REPROCESS_RUN === 'true';
const ORDER = process.env.JASEC_UI_REPROCESS_ORDER ?? '';

/** Staged for a JASEC session - reprocessing one would consume it. */
const DO_NOT_TOUCH = ['ORD-1322', 'ORD-1323', 'ORD-1381'];

let db: DbHelper;

test.beforeAll(async () => {
  if (!RUN) return;
  db = new DbHelper();
  await db.connect();
});

test.afterAll(async () => {
  if (db) await db.disconnect();
});

test.describe('JEPYP-27 - manual reprocess through the UI', () => {
  test('Submit order on a failed order re-dispatches to the AMI', async ({ page }) => {
    test.skip(!RUN, 'GATED: dispatches to the live AMI. Set JASEC_UI_REPROCESS_RUN=true.');
    test.skip(!ORDER, 'BLOCKED: set JASEC_UI_REPROCESS_ORDER to an order in PROVISIONING_ERROR.');
    test.setTimeout(600_000);

    expect(DO_NOT_TOUCH, `${ORDER} is staged for a JASEC session.`).not.toContain(ORDER);

    // ---------- preconditions, from the database ----------
    const pre = await db.query<{ status: string; svcline: string; seq: string; meter: string }>(
      `SELECT coalesce(o.status,'') AS status,
              coalesce((SELECT os.status FROM core_oms.order_services os WHERE os.id=o.id LIMIT 1),'') AS svcline,
              coalesce((SELECT sl.status FROM core_oms.order_prov_sequence_list sl WHERE sl.id=o.id LIMIT 1),'') AS seq,
              coalesce((SELECT sp.provisioningid FROM core_engine.service_unit su
                          JOIN core_engine.service_provision sp ON sp.id=su.id AND sp.type='METER'
                         WHERE su.accountid=o.accountid LIMIT 1),'') AS meter
         FROM core_oms."order" o WHERE o.id = $1`, [ORDER]);
    expect(pre.length, `${ORDER} does not exist on this tenant.`).toBe(1);
    const { status, svcline, seq, meter } = pre[0];
    console.log(`  ${ORDER}: ${status}, service line ${svcline}, sequence ${seq}, meter ${meter || '(none)'}`);

    expect(status, 'This case is about an order stopped at PROVISIONING_ERROR.')
      .toBe('PROVISIONING_ERROR');
    expect(seq, 'The provisioning step must be FAILED for the reprocess to have anything to re-run.')
      .toBe('FAILED');
    expect(
      svcline,
      `Service line is ${svcline}. Only no-status, PROVISIONING_INITIATED or ` +
      `CREATED survive the service filter - anything else short circuits before ` +
      `the sequence loop, so this test would prove nothing.`,
    ).toBe('CREATED');

    // The order must not be dated ahead of the CCP clock. createddate is not a
    // real date here - the tenant runs on a frozen clock - and an order dated in
    // the future makes the re-submit schedule a FUTURE_ORDERS job for that date.
    // If no Job Schedule Config row exists for it the order fails THERE, before
    // provisioning is reached, and the run looks like a reprocess defect.
    // Cost one run and ORD-965's usable state on 2026-09-08.
    const dated = await db.query<{ ahead: boolean; created: string }>(
      `SELECT o.createddate > now() AS ahead, o.createddate::date::text AS created
         FROM core_oms."order" o WHERE o.id = $1`, [ORDER]);
    expect(
      dated[0]?.ahead,
      `${ORDER} is dated ${dated[0]?.created}, ahead of the clock. Re-submitting ` +
      `it schedules a FUTURE_ORDERS job for that date, which is almost certainly ` +
      `not configured, and the order fails before provisioning runs - proving ` +
      `nothing about reprocess. Pick an order dated in the past.`,
    ).toBe(false);

    // Never reprocess onto a meter JASEC actually act on.
    const accepted = await db.query<{ medidor: string }>(
      `SELECT DISTINCT substring(request::text from '<medidor>([^<]+)') AS medidor
         FROM core_engine.activity
        WHERE apiname ILIKE '%UTILITIES%' AND response::text LIKE '%CodRespuesta>00<%'`);
    expect(
      accepted.map(a => a.medidor).filter(Boolean),
      `${ORDER} would dispatch meter ${meter}, which JASEC have accepted before - ` +
      `that is a real device and this test must never touch one.`,
    ).not.toContain(meter);

    const countCmds = async (): Promise<number> => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM core_engine.activity
          WHERE apiname ILIKE '%UTILITIES%' AND request::text LIKE $1`, [`%${ORDER}%`]);
      return Number(r[0]?.n ?? 0);
    };
    const before = await countCmds();
    console.log(`  commands before: ${before}`);

    // ---------- the UI ----------
    // Route is /orders/:id/detail (ui/core RouteNames.orderDetail). networkidle
    // matters here: this SPA drops the token if asserted against too early.
    await page.goto(`/orders/${ORDER}/detail`);
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByText('Order Data'),
      'The order detail page did not render - check the route and that the session is valid.',
    ).toBeVisible({ timeout: 60_000 });

    await expect(
      page.getByText('PROVISIONING_ERROR').first(),
      'The page does not show PROVISIONING_ERROR, so this is not the order we staged.',
    ).toBeVisible({ timeout: 30_000 });

    const submit = page.getByRole('button', { name: /^\s*submit\s*order\s*$/i }).first();

    await expect(
      submit,
      'The Submit order button is not on the page. It lives on the order detail ' +
      'screen and is enabled for PROVISIONING_ERROR - if it is missing, either ' +
      'the page did not render or the build does not have it.',
    ).toBeVisible({ timeout: 30_000 });

    await expect(
      submit,
      'The Submit order button is DISABLED. It is gated on the SUBMIT_ORDER ' +
      'permission, which some roles hold as READ_ONLY - a disabled button looks ' +
      'exactly like the feature not being built, so check the role before ' +
      'concluding anything.',
    ).toBeEnabled({ timeout: 30_000 });

    await submit.click();
    console.log('  clicked Submit order');

    // ---------- did it actually reach JASEC ----------
    // Re-read each time. The status flicks to SUBMITTED and then settles back,
    // so the dispatch is the assertion, not the on-screen status.
    let after = before;
    for (let i = 0; i < 36 && after === before; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      after = await countCmds();
    }
    console.log(`  commands after: ${after}`);

    const post = await db.query<{ status: string; reason: string; seq: string; retried: number }>(
      `SELECT coalesce(o.status,'') AS status, coalesce(o.reason,'') AS reason,
              coalesce((SELECT sl.status FROM core_oms.order_prov_sequence_list sl WHERE sl.id=o.id LIMIT 1),'') AS seq,
              (SELECT sl.retriedcount FROM core_oms.order_prov_sequence_list sl WHERE sl.id=o.id LIMIT 1) AS retried
         FROM core_oms."order" o WHERE o.id = $1`, [ORDER]);
    console.log(`  after: ${post[0]?.status} / "${post[0]?.reason}" / sequence ${post[0]?.seq} / retried ${post[0]?.retried}`);

    expect(
      after,
      `Submit order was pressed but no command reached the AMI. The button and ` +
      `the mutation are not the problem if you got this far - check ` +
      `config_prov_sequence_list.onErrorResubmit, which must be TRUE for a ` +
      `FAILED step to re-execute. It was false on both JASEC sequences until ` +
      `2026-09-07 and that was the original cause of this looking unbuilt.`,
    ).toBeGreaterThan(before);
  });
});
