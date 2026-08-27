import { ParsedEmail } from '../../helpers/email.helper';

/**
 * Shared shape for every Embrix notification template under JEPYP-230.
 *
 * Adding a new notification (JEPYP-50 low balance, -51 balance ended,
 * -52 reconnection, -53 minimum top-up, -54 invoice + statement, -55 template
 * images) means adding ONE file next to this one that exports a
 * NotificationTemplate. The IMAP helper, the check runner and the Jira report
 * generator are all template-agnostic and need no changes.
 */

/** Everything a check can assert against. Extend as new templates need more. */
export interface NotificationContext {
  /** Account the notification was triggered for. */
  accountId: string;
  firstName: string;
  lastName: string;
  /** Address the account's billing contact was created with. */
  recipient: string;
  /** CCP (frozen sandbox) date at trigger time, YYYY-MM-DD. */
  ccpDate: string;
  /** The email under assertion. */
  email: ParsedEmail;
  /**
   * Wall-clock seconds between triggering the event and the email arriving.
   *
   * OPTIONAL because delivery is not always observable: when IMAP does not
   * surface the message in time, TS-01 falls back to the stored
   * email_notification row to assert content. Delivery is then genuinely
   * unknown, and reporting 0 would claim instant delivery.
   */
  deliverySeconds?: number;

  // ── Top-up specific. Optional so other templates can omit them. ──────
  /** Amount topped up, as a positive number of CRC. */
  topUpAmount?: number;
  /** Signed CRC balance read from the DB after the top-up (negative = credit). */
  balanceAfter?: number;
  /** Payment channel Embrix recorded for the top-up. */
  paymentSource?: string;

  // ── Billing-event specific (JEPYP-230 sections 1, 3, 4, 5, 7). ────────
  // Only a live staged run can populate these; checks that read them must be
  // marked `contextual` so the content smoke test skips rather than fails them.
  /** `minimumtopupamount` for the account at run time. */
  X?: number;
  /** The account's cycle charge, measured not assumed. */
  C?: number;
  /** Balance the notification branch actually read: staged balance + C. */
  postBalance?: number;
  /** Balance staged before the run. */
  stagedBalance?: number;
  /** kWh the engine saw, evaluated against the CCP date. */
  kwhInWindow?: number | null;
  /** Invoice this notification refers to (Event 7). */
  invoiceId?: string;
  /** `email_notification.status` — SUCCESS, or FAILED when SMTP refused it. */
  notificationStatus?: string;
  /** Deployed template filename, e.g. `jasec_credit_threshold_breach_v2.html`. */
  templateFile?: string | null;
}

/** One row of the QA table — maps 1:1 onto a row in the Jira comment. */
export interface FieldCheck {
  /** Row label in the Jira table, e.g. 'Número de Servicio'. */
  row: string;
  /** Human-readable expected value, rendered into the report. */
  expected: (ctx: NotificationContext) => string;
  /** Value pulled out of the email. */
  actual: (ctx: NotificationContext) => string;
  /**
   * Custom comparison. Defaults to whitespace/colón-insensitive equality of
   * `actual` and `expected`. Supply this for contains-checks, regex patterns,
   * or anything where the report string isn't literally the assertion.
   */
  compare?: (actual: string, expected: string, ctx: NotificationContext) => boolean;
  /**
   * Set when a field is a known open defect. The check still runs and still
   * reports Fail, but does NOT fail the Playwright run — so the suite stays
   * usable as a regression gate while the defect is open.
   *
   * Delete this property when the fix lands; the check becomes blocking.
   */
  knownDefect?: string;
  /**
   * True when the check needs data only a live staged run can supply (X, C,
   * post-charge balance, the staged kWh band).
   *
   * The content smoke test replays historical `email_notification` rows, where
   * those figures are unrecoverable — it skips these rather than reporting
   * false failures. Everything not marked `contextual` is assertable against
   * any past rendering, which is what makes the smoke test possible.
   */
  contextual?: boolean;
}

export interface NotificationTemplate {
  /** Stable id, e.g. 'TOPUP_CONFIRMATION'. */
  key: string;
  /** Jira ticket this template is specified by. */
  ticket: string;
  /** Title used in the report heading. */
  title: string;
  /** Exact expected subject line. */
  subject: string;
  /** Ordered checks — report rows appear in this order. */
  checks: FieldCheck[];
}

export type CheckResult = {
  row: string;
  expected: string;
  actual: string;
  passed: boolean;
  knownDefect?: string;
};
