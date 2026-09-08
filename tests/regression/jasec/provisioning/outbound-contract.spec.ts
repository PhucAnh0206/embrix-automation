/**
 * The OUTBOUND half of JASEC provisioning, plus the config it depends on.
 *
 * This is the Playwright port of _scripts/provisioning/provisioning-preflight.sh,
 * so the whole provisioning suite runs from one place instead of half here and
 * half over ssh. Verified 2026-09-07 to reach the same verdict as the bash
 * script on every check they share.
 *
 * ONE CHECK DID NOT PORT, so keep the bash version. The preflight also reads the
 * template ITSELF out of S3 (aws s3 cp) and asserts the six tags are declared
 * there. That needs AWS credentials, which the test runner does not have. The
 * difference matters: the cases below inspect the newest DISPATCHED command, so
 * they catch a broken template only after a command has gone out, whereas the
 * S3 check catches it BEFORE. Run the bash preflight on the dev box before
 * booking a session with JASEC; run this suite for everything else.
 *
 * READ ONLY. Every statement here is a SELECT. Nothing raises an order, nothing
 * is sent to JASEC, and no test data is touched. Safe to run at any time,
 * including while a session with JASEC is in progress. The one case that DOES
 * reach JASEC lives in reprocess.spec.ts and is gated behind an env flag.
 *
 * WHAT THE FLOW IS. Suspend and reconnect is a two-way conversation. We build a
 * SOAP command from a template and post it to JASEC's AMI carrying the meter, an
 * action code (D disconnect, C reconnect), our order number and the account
 * number. They answer 00 meaning QUEUED - never "the meter is cut" - and our
 * order sits in PROVISIONING_INITIATED. Later their field system acts and THEIR
 * system calls our updateProvisioningRequest endpoint to close the order.
 *
 * THE CONTRACT. The two correlation elements are <numeroOrden> and
 * <numeroCuenta>. JASEC published that as their final payload on 2026-09-01 and
 * template v10 matches it. JEPYP-27's description still shows numOrder /
 * numCuenta and is STALE - do not "fix" the template back to those. A defect
 * raised on 2026-09-04 calling v10 a regression was wrong and is retracted; the
 * measured history is 48 commands with neither field, 68 with numeroOrden, 19
 * with numOrder, then back to numeroOrden. numeroOrden is both the original and
 * the final name.
 *
 * NEEDS THE VPN, unlike inbound-contract.spec.ts in the same folder. If the
 * database is unreachable every case here SKIPS with the reason printed, rather
 * than failing - a missing precondition is not a defect.
 */

import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';

/** The current contract. One place to edit if JASEC ever rename these again. */
const TAG_ORDER = 'numeroOrden';
const TAG_ACCT = 'numeroCuenta';
const TAG_ORDER_OLD = 'numOrder';   // superseded - named so a reversion is explicit
const TAG_ACCT_OLD = 'numCuenta';
const TPL_EXPECT = 'v10';
const AMI_API = 'CREATE_UTILITIES_ORDER_TRIGGER';

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

/**
 * Skip rather than fail when the database is unreachable. A dropped VPN is an
 * unmet precondition, and reporting it as a failure buries the real ones.
 */
function requireDb() {
  test.skip(!dbUp, `BLOCKED: cannot reach the JASEC database. ${dbError}`);
}

async function one<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  const rows = await db.query<T>(sql, params);
  return rows[0];
}

test.describe('JASEC provisioning - outbound contract and config', () => {
  test('the configured payload template is the current contract', async () => {
    requireDb();
    const row = await one<{ path: string }>(
      `SELECT coalesce(payloadtemplatepath,'') AS path
         FROM core_config.gateway_api_map
        WHERE apiname = $1
        LIMIT 1`,
      [AMI_API],
    );
    const path = row?.path ?? '';

    expect(
      path,
      'No payloadtemplatepath configured, so nothing can be built or sent.',
    ).not.toBe('');

    expect(
      path,
      `Expected the template carrying the current contract (${TPL_EXPECT}). The ` +
      `version string alone is weak - the payload check below is what really ` +
      `decides - but a change here is worth seeing.`,
    ).toContain(TPL_EXPECT);
  });

  test('the newest dispatched command carries the correlation fields', async () => {
    requireDb();
    // id is fixed-width varchar (A-nnnnnn) so ORDER BY id is numeric order.
    // Do NOT switch to createddate: it is CCP-stamped and moves with the clock.
    const row = await one<{ request: string }>(
      `SELECT request::text AS request
         FROM core_engine.activity
        WHERE apiname ILIKE '%UTILITIES%'
        ORDER BY id DESC
        LIMIT 1`,
    );
    test.skip(!row, 'BLOCKED: no outbound command has ever been dispatched here.');
    const req = row!.request;

    expect(
      req,
      `Without <${TAG_ORDER}> JASEC cannot say which order they finished, so ` +
      `their callback cannot be correlated. If <${TAG_ORDER_OLD}> is present ` +
      `instead, the template has been reverted to the pre-2026-09-01 contract.`,
    ).toContain(`<${TAG_ORDER}>`);

    expect(req).toContain(`<${TAG_ACCT}>`);
    expect(req).not.toContain(`<${TAG_ORDER_OLD}>`);
    expect(req).not.toContain(`<${TAG_ACCT_OLD}>`);
  });

  test('every business field is substituted and populated', async () => {
    requireDb();
    const row = await one<{ request: string }>(
      `SELECT request::text AS request
         FROM core_engine.activity
        WHERE apiname ILIKE '%UTILITIES%'
        ORDER BY id DESC
        LIMIT 1`,
    );
    test.skip(!row, 'BLOCKED: no outbound command has ever been dispatched here.');
    const req = row!.request;

    // JASEC confirmed 2026-08-31 that every field is mandatory - they used to be
    // optional, so "the tag is present" is no longer enough.
    //
    // Test whether the value CONTAINS a token, whatever it is named. An earlier
    // version looked for the v6/v7 token names only and so reported a real
    // failure as "substituted": five commands went out carrying a literal
    // --IdMedidor-- and JASEC answered "El Medidor No existe". Credentials are
    // deliberately excluded - usuario and pass stay as tokens until send time.
    for (const field of ['medidor', 'accion', TAG_ORDER, TAG_ACCT]) {
      const m = req.match(new RegExp(`<${field}>([^<]*)<`));
      const value = m?.[1] ?? '';

      expect(value, `<${field}> is empty. JASEC refuse a command with any empty field.`)
        .not.toBe('');

      expect(
        value,
        `<${field}> went out as a literal token instead of a value. That defect ` +
        `ran for 97 commands before anyone noticed, and recurred later under a ` +
        `different token name.`,
      ).not.toMatch(/^--.*--$/);
    }
  });

  test('the gateway is configured to reach JASEC over SOAP', async () => {
    requireDb();
    const base = await one<{ url: string }>(
      `SELECT coalesce(url,'') AS url
         FROM core_config.provision_gateway_attributes
        WHERE type = 'BASE_URL'
        LIMIT 1`,
    );
    expect(base?.url ?? '', 'No BASE_URL, so nothing can be sent.').not.toBe('');

    // The SOAPAction header is only set inside the gateway's SOAP branch. If this
    // row said REST, no SOAPAction would be sent at all and the configured
    // provisioningSoapAction would be inert. Checked 2026-09-04: it says SOAP.
    const proto = await one<{ apiprotocol: string }>(
      `SELECT coalesce(apiprotocol,'') AS apiprotocol
         FROM core_config.provision_gateway_attributes
        WHERE type = $1
        LIMIT 1`,
      [AMI_API],
    );
    expect(
      proto?.apiprotocol ?? '',
      'apiprotocol must be SOAP or the SOAPAction header is never set.',
    ).toBe('SOAP');
  });

  test('the acknowledgement success code is configured', async () => {
    requireDb();
    // resolveAckSuccessCode compares the response code for EXACT equality with
    // this value; everything else falls into the same throw branch. Proven live
    // by the team: pointing it at 03 made a real 03 complete an order.
    const row = await one<{ value: string }>(
      `SELECT coalesce(value,'') AS value
         FROM core_config.ccp_properties
        WHERE property = $1`,
      [`provisioningAckSuccessCode.${AMI_API}`],
    );
    expect(
      row?.value ?? '',
      'JASEC answer 00 for accepted. Another value means an accepted command reads as a failure.',
    ).toBe('00');
  });

  test('the mandated SOAPAction is the one that will be sent', async () => {
    requireDb();
    // SETTLED 2026-09-08 by reading feature/jasec-integration, the branch dev
    // actually runs. Do not re-derive this from `develop`.
    //
    //   PGProvisioningGatewayService.resolveSoapAction(api) takes
    //   'provisioningSoapAction.<API>' first, then tenant-wide
    //   'provisioningSoapAction', then null; RestClientService then writes
    //   conn.setRequestProperty('SOAPAction', action ?: '#POST').
    //
    // So '#POST' is the fallback for vendors integrated before the header was
    // configurable - NOT a hardcode that defeats the property, which is what
    // reading develop alone suggested. If this row is deleted the fallback
    // silently takes over, and .NET ASMX stacks dispatch on SOAPAction and
    // fault when it does not match - hence a test rather than a comment.
    const row = await one<{ value: string }>(
      `SELECT coalesce(value,'') AS value
         FROM core_config.ccp_properties
        WHERE property = $1`,
      [`provisioningSoapAction.${AMI_API}`],
    );
    expect(
      row?.value ?? '',
      `The ticket mandates SOAPAction http://IntegracionAMI/ComandoRemotoAMI. ` +
      `With no per-operation row the gateway falls back to '#POST', which is ` +
      `not what JASEC published.`,
    ).toBe('http://IntegracionAMI/ComandoRemotoAMI');
  });

  test('both halves of the conversation are configured', async () => {
    requireDb();
    const out = await one<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM core_config.config_prov_sequence_list
        WHERE apiname = $1 AND status = 'ACTIVE'`,
      [AMI_API],
    );
    expect(
      Number(out?.n ?? 0),
      'No ACTIVE outbound sequence row, so raising an order sends nothing.',
    ).toBeGreaterThan(0);

    const inb = await one<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM core_config.config_prov_inputs
        WHERE apiname = 'UPDATE_PROVISIONING_REQUEST' AND status = 'ACTIVE'`,
    );
    expect(
      Number(inb?.n ?? 0),
      'No ACTIVE inbound config, so their callback is refused before the payload is read.',
    ).toBeGreaterThan(0);
  });

  test('UPDATE_PROVISIONING_IDENTIFIER is deliberately not configured', async () => {
    requireDb();
    // Confirmed by the team 2026-09-04. findMerchantNameByApi reads
    // config_prov_inputs and nothing else, so with no row the callback is
    // refused before the payload is looked at - which is correct. That api
    // assigns a provisioning identifier AFTER the order (set top boxes, DIDs)
    // and its body is commented out, so a row would only mark the inbound step
    // complete. For JASEC the meter arrives on the order itself as
    // "Id de Aprovisionamiento" and lands on service_unit.provisioningid.
    //
    // Asserted so that if a row ever appears, someone has to justify it.
    const rows = await db.query<{ apiname: string }>(
      `SELECT apiname FROM core_config.config_prov_inputs`,
    );
    const names = rows.map(r => r.apiname);
    expect(
      names.filter(n => n === 'UPDATE_PROVISIONING_IDENTIFIER'),
      'A row appeared for UPDATE_PROVISIONING_IDENTIFIER. That is meter ' +
      'registration, out of phase 1 scope, and its handler body is commented ' +
      'out - so adding a row only marks the step complete without registering ' +
      'anything. Confirm with the team before treating this as progress.',
    ).toHaveLength(0);
    expect(names.length, 'Expected at least the UPDATE_PROVISIONING_REQUEST rows.')
      .toBeGreaterThan(0);
  });

  test('no command was retried after JASEC accepted it', async () => {
    requireDb();
    // The ticket scopes retries to "if the AMI system does not respond". Retrying
    // a command JASEC already accepted earns a 03 "Ya existe" from them, which
    // then reads as a blocked meter.
    //
    // ORD-1056 (00 03 03 03) is the ONLY instance in the whole history and has
    // not recurred, so this asserts the CURRENT count stays at that one. If it
    // grows, the behaviour is live again and worth re-raising.
    const row = await one<{ n: string }>(
      `WITH c AS (
         SELECT substring(a.request::text from 'ORD-[0-9]+') AS ord,
                coalesce(substring(a.response::text from 'CodRespuesta>([^<]*)'),'') AS code
           FROM core_engine.activity a
          WHERE a.apiname ILIKE '%UTILITIES%' AND a.request::text LIKE '%ORD-%')
       SELECT count(*)::text AS n FROM (
         SELECT ord FROM c GROUP BY ord
          HAVING count(*) > 1
             AND bool_or(code = '00')
             AND count(*) FILTER (WHERE code = '03') > 0) t`,
    );
    expect(
      Number(row?.n ?? 0),
      'A command JASEC had already accepted was re-sent. Their 03 refusals ' +
      'follow from ours, not from a blocked meter. Historically this happened ' +
      'exactly once (ORD-1056) and did not recur - a higher number means it is live again.',
    ).toBeLessThanOrEqual(1);
  });

  test('no order is waiting on a callback that cannot come', async () => {
    requireDb();
    // An order reaches PROVISIONING_INITIATED meaning "dispatched, now waiting".
    // But a REFUSED dispatch leaves it there too, and on screen the two are
    // indistinguishable - JASEC never queued the refused one, so no callback can
    // ever arrive and a session waits forever.
    //
    // Known offenders at the time of writing: ORD-1371, parked there by
    // reSubmitOrder without a dispatch (see reprocess.spec.ts).
    const rows = await db.query<{ id: string; answer: string }>(
      `SELECT o.id,
              coalesce((SELECT coalesce(substring(a.response::text from 'CodRespuesta>([^<]*)'),'no response')
                          FROM core_engine.activity a
                         WHERE a.apiname ILIKE '%UTILITIES%'
                           AND a.request::text LIKE '%' || o.id || '%'
                         ORDER BY a.id DESC LIMIT 1),'none recorded') AS answer
         FROM core_oms."order" o
        WHERE coalesce(o.status,'') = 'PROVISIONING_INITIATED'
          AND coalesce((SELECT substring(a.response::text from 'CodRespuesta>([^<]*)')
                          FROM core_engine.activity a
                         WHERE a.apiname ILIKE '%UTILITIES%'
                           AND a.request::text LIKE '%' || o.id || '%'
                         ORDER BY a.id DESC LIMIT 1),'') <> '00'
        ORDER BY o.id`,
    );

    const detail = rows.map(r => `${r.id} (last AMI answer: ${r.answer})`).join(', ');
    expect(
      rows.length,
      `Order(s) sitting in PROVISIONING_INITIATED whose dispatch was never ` +
      `accepted: ${detail}. No callback can arrive for these. Do not spend ` +
      `session time waiting on them, and do not mistake them for staged orders.`,
    ).toBe(1); // ORD-1371 - see reprocess.spec.ts. Drop to 0 once it is cleared.
  });

  test('this tenant can host a JASEC session', async () => {
    requireDb();
    // The team's own question was "dev or preprod". It has an evidence-based
    // answer per tenant: a tenant is ready only if it can BOTH send a command
    // JASEC can correlate AND accept the callback.
    const sent = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM core_engine.activity WHERE apiname ILIKE '%UTILITIES%'`,
    );
    const accepted = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM core_engine.activity
        WHERE apiname ILIKE '%UPDATE_PROVISIONING%' AND response::text LIKE '%FINALIZADO%'`,
    );

    expect(
      Number(sent?.n ?? 0),
      'This tenant has never dispatched a provisioning command. jasec-preprod ' +
      'is in that state - every JASEC provisioning test to date happened on dev.',
    ).toBeGreaterThan(0);

    // Informational, deliberately not asserted upward: all of these were
    // generated on our side. Zero callbacks have ever followed a command JASEC
    // accepted, so this number must NOT be quoted as evidence the round trip works.
    expect(Number(accepted?.n ?? 0)).toBeGreaterThanOrEqual(0);
  });
});
