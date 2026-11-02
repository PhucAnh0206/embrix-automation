import { DbHelper } from './db.helper';
import { poll } from './poll.helper';

/** Order states after which an order no longer changes. */
export const ORDER_TERMINAL = ['COMPLETED', 'CANCELLED', 'PROVISIONING_ERROR', 'BILLING_ERROR', 'FAILED', 'REJECTED'];

export interface Sub { id: string; status: string; buid: string; balance: number }

/** The account's subscriptions, oldest first, with their CRC balance (JASEC sign: credit reads negative). */
export async function subscriptions(db: DbHelper, accountId: string): Promise<Sub[]> {
  const r = await db.query<{ id: string; status: string; buid: string; amount: string | null }>(
    `SELECT s.id, s.status, s.balanceunitid AS buid,
            (SELECT b.amount FROM core_engine.balance_unit_balances b WHERE b.id = s.balanceunitid AND b.currencyid = 'CRC') AS amount
       FROM core_engine.subscription s WHERE s.accountid = $1 ORDER BY s.createddate, s.id`, [accountId]);
  return r.map(x => ({ id: x.id, status: x.status, buid: x.buid, balance: Number(x.amount ?? 0) }));
}

/** Wait until the order reaches a terminal state; returns that state, or the last one seen after `maxSeconds`. */
export async function orderSettled(db: DbHelper, orderId: string, maxSeconds = 240): Promise<string> {
  return poll(async () => (await db.query<{ s: string }>(`SELECT status AS s FROM core_oms."order" WHERE id = $1`, [orderId]))[0]?.s ?? '(none)',
    s => ORDER_TERMINAL.includes(s), maxSeconds * 1000, 5_000);
}

/** The provisioning id of the account's ACTIVE service unit (waits up to 2 min); throws when there is none. */
export async function activeProvisioningId(db: DbHelper, accountId: string): Promise<string> {
  const p = await poll(async () => (await db.query<{ p: string }>(
    `SELECT provisioningid AS p FROM core_engine.service_unit WHERE accountid = $1 AND status = 'ACTIVE' LIMIT 1`, [accountId]))[0]?.p ?? '',
    v => !!v, 120_000, 5_000);
  if (!p) throw new Error(`${accountId}: no ACTIVE service unit after 2 min`);
  return p;
}
