import { expect } from '@playwright/test';
import { DbHelper } from './db.helper';
import { blockedIf } from './blocked.helper';

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

/**
 * Before a DAILY run: is any service on a meter JASEC's AMI has ACCEPTED before (a real device) about to be cut?
 *
 * Anh 2026-10-20: billing runs may bill or cut OTHER accounts on dev / preprod at any time, with one exception -
 * never cut a real device. dev, preprod and prod share JASEC's live AMI, and on dev 339400 and 324030 have been
 * accepted (JASEC's staged accounts 031201 / ACT-100064 / 01365966). CREDIT_LIMIT_ACTIONS in the run cuts a
 * subscription that is over its limit, and the run's own bill can push a due account over it, so "at risk" =
 * over the limit now, or due on `date` and less than AT_RISK_MARGIN CRC of credit away from the limit.
 * Same over-limit join as the TC-153 own-data guard, CRC balance only.
 */
export const AT_RISK_MARGIN = 10_000;

export async function acceptedMetersAtRisk(db: DbHelper, date?: string): Promise<{ account: string; meter: string; balance: string; due: boolean }[]> {
  return db.query(
    `WITH accepted AS (
       SELECT DISTINCT substring(request::text from '<medidor>([^<]+)') AS m
         FROM core_engine.activity WHERE apiname ILIKE '%UTILITIES%' AND ${ACCEPTED_REPLY_SQL})
     SELECT DISTINCT a.id AS account, sp.provisioningid AS meter, bub.amount::text AS balance,
            coalesce(bp.nextaccountingdate <= $1::date - core_engine.get_future_cycle_date(bp.accountid), false) AS due
       FROM core_engine.service_provision sp
       JOIN core_engine.service_unit su ON su.id = sp.id AND su.status <> 'CLOSED'
       JOIN core_engine."subscription" s ON s.id = su.subscriptionid AND s.status = 'ACTIVE'
       JOIN core_engine.account a ON a.id = s.accountid
       JOIN core_config.credit_profile c ON c.name = s.creditprofilename
       JOIN core_config.credit_profiles cp ON cp.id = c.id AND cp.currency = a.currency
       JOIN core_engine.balance_unit_balances bub ON bub.id = s.balanceunitid AND bub.currencyid = a.currency
       LEFT JOIN core_engine.billing_profile bp ON bp.accountid = a.id
      WHERE sp.type = 'METER' AND sp.provisioningid IN (SELECT m FROM accepted)
        AND EXISTS (SELECT 1 FROM core_config.credit_profile_limit_actions l WHERE l.id = cp.id AND l.refindex = cp.index)
        AND (bub.amount > cp.creditlimit
             OR ($1::date IS NOT NULL AND bp.nextaccountingdate <= $1::date - core_engine.get_future_cycle_date(bp.accountid)
                 AND bub.amount + $2 > cp.creditlimit))`,
    [date ?? null, AT_RISK_MARGIN]);
}

/**
 * BLOCKED (skips the test) when a DAILY run on `date` could cut a real device. JASEC tenants only; opens its own
 * DB connection when none is given. A DB that cannot be reached fails closed (BLOCKED), it does not run blind.
 */
export async function blockIfAcceptedMeterAtRisk(date?: string, db?: DbHelper): Promise<void> {
  if (!/^jasec/.test((process.env.TEST_ENV ?? '').trim())) return;
  const own = !db;
  const conn = db ?? new DbHelper();
  let risk: Awaited<ReturnType<typeof acceptedMetersAtRisk>> = [];
  let failure = '';
  try {
    if (own) await conn.connect();
    risk = await acceptedMetersAtRisk(conn, date);
  } catch (e) {
    failure = String((e as Error)?.message ?? e);
  } finally {
    if (own) await conn.disconnect().catch(() => {});
  }
  // Outside the try: blockedIf skips the test by throwing, and that must not be caught as a DB failure.
  blockedIf(!!failure, `cannot check for AMI-accepted meters at risk (${failure}) - not running blind`);
  blockedIf(risk.length > 0,
    `a DAILY run${date ? ` on ${date}` : ''} could cut a REAL device on JASEC's AMI: ` +
    risk.map(r => `${r.account} meter ${r.meter} balance ${r.balance}${r.due ? ' (due)' : ''}`).join(', ') +
    ` - top the account up or pick another date (cut-window rule, 2026-10-20)`);
}
