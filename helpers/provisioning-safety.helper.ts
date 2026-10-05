import { expect } from '@playwright/test';
import { DbHelper } from './db.helper';

/**
 * The one definition of "safe to send to JASEC's AMI" for the provisioning specs.
 *
 * It used to live in five specs as five copies, and they had drifted: the
 * DO_NOT_TOUCH lists differed (reprocess-failed-step lacked ORD-1059), and two copies
 * counted a reply as ACCEPTED on `CodRespuesta>00<` alone while the newer ones
 * also matched "Operación Registrada". A guard that disagrees with itself is only
 * as strong as its weakest copy.
 *
 * THE RULE. A command may only go out on a meter this suite INVENTED - an
 * `M-QA...` id, which cannot be a JASEC device - and that JASEC have never
 * accepted. Numeric meters are JASEC's real device shape (00210018641144770), so
 * a numeric meter is never a safe subject however it got onto an account.
 *
 * The meter that is checked is `core_engine.service_provision.provisioningid`
 * (type METER, keyed by service-unit id), because that is what the engine puts on
 * the wire - NOT `service_unit.provisioningid`, which holds a `prov-*` placeholder.
 *
 * Owner: Anh Tran (QC).
 */

/** Every meter a provisioning spec invents starts with this. */
export const QA_METER_PREFIX = 'M-QA';

/** Orders staged for a JASEC session. Never name, reprocess or close one. */
export const DO_NOT_TOUCH_ORDERS = ['ORD-1059', 'ORD-1322', 'ORD-1323', 'ORD-1381'];

/** Accounts behind those orders. Never build on these. */
export const STAGED_ACCOUNTS = ['ACT-100064', '01365966', '031201', 'ACT-100774'];

/** A JASEC reply meaning the command was ACCEPTED (queued), on either reply shape. */
export const ACCEPTED_REPLY_SQL =
  `(response::text LIKE '%CodRespuesta>00<%' OR response::text ILIKE '%Operaci_n Registrada%')`;

export function isQaMeter(meter: string | null | undefined): boolean {
  return !!meter && meter.startsWith(QA_METER_PREFIX);
}

/**
 * Refuse unless the meter on service_provision for `svcId` is the one the caller
 * invented, carries `prefix` (a QA prefix), and has never been accepted by JASEC.
 * Re-reads the accepted set at call time, so a newly released meter is excluded
 * even mid-run. Returns the meter that will go on the wire.
 */
export async function assertSafeToDispatch(
  db: DbHelper,
  s: { accountId: string; svc: string; meter: string },
  prefix: string = QA_METER_PREFIX,
): Promise<string> {
  expect(prefix.startsWith(QA_METER_PREFIX), `${prefix} is not a QA meter prefix`).toBe(true);
  const wire = await db.query<{ m: string }>(
    `SELECT sp.provisioningid AS m FROM core_engine.service_provision sp
      WHERE sp.id = $1 AND sp.type = 'METER'`, [s.svc]);
  const meter = wire[0]?.m ?? '';
  expect(meter, `${s.accountId}: the meter on service_provision is not the one this spec invented`)
    .toBe(s.meter);
  expect(meter.startsWith(prefix), `${meter} is not a ${prefix} meter`).toBe(true);
  const accepted = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM core_engine.activity
      WHERE apiname ILIKE '%UTILITIES%' AND request::text LIKE $1 AND ${ACCEPTED_REPLY_SQL}`,
    [`%<medidor>${meter}</medidor>%`]);
  expect(Number(accepted[0]?.n ?? 0), `${meter} has been ACCEPTED by JASEC before - a real device`).toBe(0);
  return meter;
}
