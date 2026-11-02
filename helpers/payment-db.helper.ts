import { DbHelper } from './db.helper';

/**
 * Database side of the Self Care payment flow — target selection and
 * before/after snapshots.
 *
 * The chain a payment touches, traced on jasec-dev 2026-08-26:
 *
 *   core_engine.invoice_unit    status ACTIVE → CLOSED, due → 0,
 *                              lastaraction → 'PAYMENT'
 *   core_engine.payment         new row (P<n>), status CLOSED,
 *                              method CREDIT_CARD, invoiceunitid = the invoice,
 *                              externaltransid = the PlaceToPay transaction
 *   core_engine.arops_unit      new row type PAYMENT, netamount NEGATIVE,
 *                              source AGENT_CARE, invoiceid = the invoice
 *   balance_unit_balances       amount moves DOWN by the paid amount
 *
 * On the sign convention: JASEC CRC is inverted. Negative = credit the customer
 * can consume, positive = debt. A payment therefore SUBTRACTS from `amount`, and
 * "the balance went down by 2,319.30" is the correct expectation, not a bug. The
 * customer-visible wording is the opposite ("credit went up"), which is why every
 * assertion here is written against the signed DB value and never against a
 * word like "increase".
 */

export interface InvoiceRow {
  id: string;
  status: string;
  total: number;
  due: number;
  invoicedate: string;
  duedate: string;
  lastaraction: string | null;
}

export interface PaymentRow {
  id: string;
  invoiceunitid: string | null;
  amount: number;
  remainingamount: number;
  status: string;
  method: string | null;
  externaltransid: string | null;
  filepath: string | null;
  folioid: string | null;
  foliostatus: string | null;
  sourcecurrencyid: string | null;
  paymentsource: string | null;
  userid: string | null;
  paymentdate: string;
  createddate: string;
}

export interface AropsRow {
  id: string;
  type: string;
  invoiceid: string | null;
  netamount: number;
  source: string | null;
  userid: string | null;
  itemid: string | null;
}

export interface AccountPaymentState {
  accountId: string;
  accountStatus: string;
  accountCurrency: string;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  /** Signed wallet balance. Negative = customer credit, positive = debt. */
  balance: number | null;
  openInvoices: InvoiceRow[];
  allInvoices: InvoiceRow[];
  payments: PaymentRow[];
  aropsPayments: AropsRow[];
}

/** Candidate account for a paying test: has a saved card and something to pay. */
export interface PayableTarget {
  accountId: string;
  last4cc: string;
  /** Account currency. CRC for real JASEC accounts; jasec-dev also has USD ones. */
  currency: string;
  openInvoiceCount: number;
  smallestDue: number;
}

/**
 * Accounts that can actually be used for a payment test, cheapest first.
 *
 * Both halves are required: a saved card (so PAY NOW is reachable without a
 * tokenization round trip first) and an open invoice (so there is something to
 * settle). `maxDue` keeps the test off the multi-million-CRC invoices that heavy
 * MDR runs leave behind — a real charge against the PlaceToPay test gateway for
 * 5,354,343.60 is not something to fire casually.
 *
 * Ordered so a run consumes the least valuable data available, and returns a LIST
 * rather than one row so a caller can skip accounts already used in this run.
 */
export async function findPayableTargets(
  db: DbHelper,
  opts: {
    maxDue?: number;
    minOpenInvoices?: number;
    limit?: number;
    /**
     * Account currency to restrict to. Defaults to CRC — jasec-dev carries a
     * handful of USD-currency prepaid accounts among the CRC ones (ACT-100489 is
     * one), and a PlaceToPay payment on a USD account is APPROVED by the gateway
     * and then never recorded by Embrix. Letting one into the pool turns a
     * settlement test into a re-run of that defect. Pass null to include every
     * currency, which is what the case pinned on that defect does.
     */
    currency?: string | null;
  } = {},
): Promise<PayableTarget[]> {
  const { maxDue = 20000, minOpenInvoices = 1, limit = 25, currency = 'CRC' } = opts;

  const rows = await db.query<any>(
    `SELECT a.id                              AS "accountId",
            max(cc.last4cc)                   AS last4cc,
            max(a.currency)                   AS currency,
            count(DISTINCT iu.id)::int        AS "openInvoiceCount",
            min(iu.due)::float8               AS "smallestDue"
     FROM core_engine.account a
     JOIN core_engine.credit_card cc ON cc.accountid = a.id
     JOIN core_engine.invoice_unit iu
       ON iu.accountid = a.id AND iu.status = 'ACTIVE' AND iu.due > 0
     JOIN core_engine.subscription s
       ON s.accountid = a.id AND s.status = 'ACTIVE'
     WHERE a.accountcategory = 'PREPAID'
       AND a.status = 'ACTIVE'
       AND ($4::text IS NULL OR a.currency = $4)
     GROUP BY a.id
     HAVING max(iu.due) <= $1
        AND count(DISTINCT iu.id) >= $2
     ORDER BY min(iu.due) ASC, a.id DESC
     LIMIT $3`,
    [maxDue, minOpenInvoices, limit, currency],
  );
  return rows;
}

/**
 * Full before/after picture for one account.
 *
 * Everything a payment can move, read in one call, so a test can snapshot, act,
 * snapshot again and diff. Dates come back as TEXT via to_char on purpose:
 * node-postgres turns a `date` column into a JS Date at local midnight, which
 * prints the previous day east of Greenwich and produces phantom one-day
 * mismatches against the UI.
 */
export async function readAccountPaymentState(
  db: DbHelper,
  accountId: string,
): Promise<AccountPaymentState> {
  const [acct] = await db.query<any>(
    `SELECT status, currency FROM core_engine.account WHERE id = $1`,
    [accountId],
  );

  const [sub] = await db.query<any>(
    `SELECT s.id, s.status, b.amount::float8 AS balance
     FROM core_engine.subscription s
     LEFT JOIN core_engine.balance_unit_balances b ON b.id = s.balanceunitid
     WHERE s.accountid = $1
     ORDER BY s.status = 'ACTIVE' DESC
     LIMIT 1`,
    [accountId],
  );

  const invoices = await db.query<InvoiceRow>(
    `SELECT id, status, total::float8 AS total, due::float8 AS due,
            to_char(invoicedate,'YYYY-MM-DD') AS invoicedate,
            to_char(duedate,'YYYY-MM-DD')     AS duedate,
            lastaraction
     FROM core_engine.invoice_unit
     WHERE accountid = $1
     ORDER BY invoicedate, id`,
    [accountId],
  );

  const payments = await db.query<PaymentRow>(
    `SELECT id, invoiceunitid, amount::float8 AS amount,
            remainingamount::float8 AS remainingamount,
            status, method, externaltransid, filepath, folioid, foliostatus,
            sourcecurrencyid, paymentsource, userid,
            to_char(paymentdate,'YYYY-MM-DD') AS paymentdate,
            to_char(createddate,'YYYY-MM-DD') AS createddate
     FROM core_engine.payment
     WHERE accountid = $1
     ORDER BY id`,
    [accountId],
  );

  const arops = await db.query<AropsRow>(
    `SELECT id, type, invoiceid, netamount::float8 AS netamount, source, userid, itemid
     FROM core_engine.arops_unit
     WHERE accountid = $1 AND type = 'PAYMENT'
     ORDER BY id`,
    [accountId],
  );

  return {
    accountId,
    accountStatus: acct?.status ?? 'UNKNOWN',
    accountCurrency: acct?.currency ?? 'UNKNOWN',
    subscriptionId: sub?.id ?? null,
    subscriptionStatus: sub?.status ?? null,
    balance: sub?.balance ?? null,
    openInvoices: invoices.filter((i) => i.status === 'ACTIVE' && i.due > 0),
    allInvoices: invoices,
    payments,
    aropsPayments: arops,
  };
}

/** Payment rows present in `after` but not in `before`. */
export function newPayments(
  before: AccountPaymentState,
  after: AccountPaymentState,
): PaymentRow[] {
  const seen = new Set(before.payments.map((p) => p.id));
  return after.payments.filter((p) => !seen.has(p.id));
}

/** AR PAYMENT rows present in `after` but not in `before`. */
export function newAropsPayments(
  before: AccountPaymentState,
  after: AccountPaymentState,
): AropsRow[] {
  const seen = new Set(before.aropsPayments.map((a) => a.id));
  return after.aropsPayments.filter((a) => !seen.has(a.id));
}

/**
 * Compare two money figures at the tenant's rounding precision.
 *
 * CRC is configured HALF_UP / 2 decimals (getCurrencyConfig, jasec-dev), and
 * Embrix documents cent-level deltas as expected rather than defects — so
 * assertions compare to 2dp and a larger gap is the thing worth reporting.
 */
export function moneyEquals(a: number, b: number, precision = 2): boolean {
  return Math.abs(a - b) < Math.pow(10, -precision) / 2;
}

/** Parse a rendered money cell ("5,354,343.6", "¢2 319,30") into a number. */
export function parseMoney(rendered: string): number {
  const cleaned = String(rendered ?? '').replace(/[^\d.,-]/g, '').trim();
  // Thousands separators are commas on this tenant; strip them, keep the dot.
  return Number(cleaned.replace(/,/g, ''));
}
