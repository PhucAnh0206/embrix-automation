/**
 * JEPYP-27 standing guards for the provisioning defects found 2026-09-28.
 * Read only - every statement is a SELECT, nothing is sent to JASEC. Runs in the
 * always-on `jasec-provisioning` project next to outbound/inbound-contract.
 *
 *   1. A SUSPEND/RESUME/CANCEL whose completion callback was ACCEPTED must be
 *      COMPLETED. (Defect 1: crm-gateway PGOmsService.provisionOrder `&&`/`||`
 *      precedence - fixed in crm_gateway 0cc6fc5.)
 *   2. A system-generated order must never fail on order_clientid_fkey.
 *      (Defect 2: the NISE in account.clientId copied onto system orders - fixed in
 *      engine 4f16ffb9f.)
 *   3. Informational: how many prepaid accounts hold a NISE in clientId. Harmless
 *      for orders since 4f16ffb9f; where NISE should live is still a product decision.
 *   4. One credit breach raises ONE automatic SUSPEND. (Defect 3: the suspend ran
 *      inside the rolled-back rating transaction and again after it - fixed in
 *      engine 5be782856.)
 *
 * PROSPECTIVE, on purpose. The fixes cannot change history, so a guard that
 * counted every historical row would fail for ever after a correct fix. Each
 * guard therefore ignores what the team already cleaned up, and names the
 * pre-fix rows it allows (KNOWN_*), so a NEW occurrence still fails. If the team
 * replays or closes one of the known rows it simply drops out.
 *
 * A wrong value from the product is a FAIL, not BLOCKED. Only a missing
 * database is BLOCKED. Write-up and team reply:
 *   notes/defects/JASEC_defect_provisioning-suspend-resume-2026-09-28.md
 *   notes/team-replies/reply-qe-suspend-resume-2026-09-28.txt
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';

/**
 * Readings lost to order_clientid_fkey BEFORE engine 4f16ffb9f was deployed.
 * Both are QA accounts; the team says they can be replayed one file at a time
 * (Reprocessing Suspended / Failed Records) with the CCP clock >= 2026-09-28.
 */
const KNOWN_PRE_FIX_FKEY_FAILURES = [
  'MDR_PREPAGO_20260928-073754.csv', // ACT-101081, manual test
  'MDR_PREPAGO_20260928-080705.csv', // ACT-101084, @auto-nise
];

let db: DbHelper;
let dbUp = false;
let dbError = '';

test.beforeAll(async () => {
  db = new DbHelper();
  try {
    await db.connect();
    dbUp = true;
  } catch (e: any) {
    dbError = e?.message ?? String(e);
  }
});

test.afterAll(async () => {
  if (dbUp) await db.disconnect();
});

/** A dropped VPN is an unmet precondition, not a defect. */
function requireDb() {
  test.skip(!dbUp, `BLOCKED: cannot reach the JASEC database. ${dbError}`);
}

test.describe('JASEC provisioning - order integrity after callbacks', () => {
  test('every SUSPEND/RESUME/CANCEL with an accepted callback is COMPLETED', async () => {
    requireDb();
    // Accepted callback = FINALIZADO in the response; the id sits in the request
    // as "orderId": "ORD-n" (quoted, so ORD-18 cannot match ORD-1869).
    const rows = await db.query<{ id: string; type: string; status: string; partial: string; lines: string; userid: string }>(
      `SELECT o.id, o.type, o.status, o.userid,
              coalesce(o.ispartialfulfillmentallowed::text, 'null') AS partial,
              (SELECT count(*)::text FROM core_oms.order_services s WHERE s.id = o.id) AS lines
         FROM core_oms."order" o
        WHERE o.type IN ('SUSPEND','RESUME','CANCEL')
          AND coalesce(o.status,'') NOT IN ('COMPLETED','CANCELLED')
          AND EXISTS (SELECT 1 FROM core_engine.activity a
                       WHERE a.apiname = 'UPDATE_PROVISIONING_REQUEST'
                         AND a.request::text LIKE '%"' || o.id || '"%'
                         AND a.response::text LIKE '%FINALIZADO%')
        ORDER BY o.id`);

    const detail = rows
      .map(r => `${r.id} ${r.type} ${r.status} (by ${r.userid}, isPartialFulfillmentAllowed=${r.partial}, service lines ${r.lines})`)
      .join('\n  ');
    const allFlagged = rows.length > 0 && rows.every(r => r.partial === 'true');
    expect(
      rows.length,
      `${rows.length} order(s) had their completion callback ACCEPTED but were never closed:\n  ${detail}\n` +
      (allFlagged
        ? `Every one carries isPartialFulfillmentAllowed=true - the Suspend/Resume screen default. That is ` +
          `Defect 1 (PGOmsService.provisionOrder precedence, fixed in crm_gateway 0cc6fc5): is the fix deployed? ` +
          `Each such order blocks new orders on its account (OPEN_ORDER_ALREADY_EXISTS).`
        : `Not all of them carry isPartialFulfillmentAllowed=true, so at least one is stuck for a DIFFERENT ` +
          `reason - trace it in the crm-gateway log before assuming the known defect.`),
    ).toBe(0);
  });

  test('no usage record failed because an automatic order could not be saved', async () => {
    requireDb();
    const rows = await db.query<{ id: string; provisioningid: string; errormsg: string }>(
      `SELECT id, provisioningid, left(errormsg, 220) AS errormsg
         FROM core_usage.file_detail_record
        WHERE errormsg ILIKE '%order_clientid_fkey%'
          AND NOT (id = ANY($1))
        ORDER BY id`, [KNOWN_PRE_FIX_FKEY_FAILURES]);
    expect(
      rows.length,
      `${rows.length} NEW meter reading(s) FAILED because the order the reading triggered (usually the ` +
      `credit-breach SUSPEND) was refused by order_clientid_fkey:\n  ` +
      rows.map(r => `${r.id} meter ${r.provisioningid}: ${r.errormsg.replace(/\s+/g, ' ')}`).join('\n  ') +
      `\nThe account was not suspended and the consumption was neither charged nor parked. Defect 2 was ` +
      `fixed in engine 4f16ffb9f - check it is deployed. (Pre-fix failures allowed: ` +
      `${KNOWN_PRE_FIX_FKEY_FAILURES.join(', ')}.)`,
    ).toBe(0);
  });

  test('prepaid accounts holding a NISE in clientId (informational)', async ({}, testInfo) => {
    requireDb();
    // Not a failure any more: since engine 4f16ffb9f a clientId that is not an
    // account id is left off system orders. Kept visible because where NISE should
    // live is still undecided (with Luis) and this is the population a decision moves.
    const r = await db.query<{ n: string; sample: string }>(
      `SELECT count(*)::text AS n,
              coalesce(string_agg(x.id || '=' || x.clientid, ', ') FILTER (WHERE x.rn <= 5), '') AS sample
         FROM (SELECT a.id, a.clientid, row_number() OVER (ORDER BY a.createddate DESC, a.id DESC) AS rn
                 FROM core_engine.account a
                WHERE a.accountcategory = 'PREPAID'
                  AND a.clientid IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM core_engine.account c WHERE c.id = a.clientid)) x`);
    const msg = `${r[0]?.n ?? 0} prepaid account(s) hold a NISE in clientId (newest: ${r[0]?.sample || 'none'})`;
    console.log(`  INFO: ${msg}`);
    testInfo.annotations.push({ type: 'info', description: msg });
  });

  test('a credit breach never leaves two automatic SUSPENDs open', async () => {
    requireDb();
    // Two CreditLimitBreach SUSPENDs in a row on one account with nothing between
    // them = one breach raised two orders (Defect 3). Pairs whose FIRST order was
    // already closed out (FAILED/CANCELLED - how the team cleaned up the pre-fix
    // pairs) are history; any other pair is a live duplicate.
    const rows = await db.query<{ accountid: string; prev: string; prevstatus: string; id: string; status: string }>(
      `SELECT accountid, prev, prevstatus, id, status FROM (
         SELECT o.accountid, o.id, o.status, o.type, o.userid,
                lag(o.id)     OVER w AS prev,
                lag(o.status) OVER w AS prevstatus,
                lag(o.type)   OVER w AS prevtype,
                lag(o.userid) OVER w AS prevuser
           FROM core_oms."order" o
         WINDOW w AS (PARTITION BY o.accountid ORDER BY length(o.id), o.id)) x
        WHERE type = 'SUSPEND' AND userid = 'CreditLimitBreach'
          AND prevtype = 'SUSPEND' AND prevuser = 'CreditLimitBreach'
          AND prevstatus NOT IN ('FAILED','CANCELLED')
        ORDER BY accountid`);
    expect(
      rows.length,
      `${rows.length} breach(es) left two automatic SUSPENDs, neither closed out:\n  ` +
      rows.map(r => `${r.accountid}: ${r.prev} (${r.prevstatus}) then ${r.id} (${r.status})`).join('\n  ') +
      `\nDefect 3 was fixed in engine 5be782856. A pair created BEFORE that deploy only needs closing ` +
      `(e.g. ACT-101091 ORD-1927/1928); one created after it means the fix is not live or not complete.`,
    ).toBe(0);
  });
});
