import { DbHelper } from './db.helper';
import { ParsedEmail, htmlToText, extractImageSrcs } from './email.helper';
import { BillingEvent } from './notification-bands';
import { TestLogger } from './test-logger';

/**
 * NotificationDbHelper — everything the JEPYP-230 notification suite needs from
 * Postgres: staging, per-account measurement, and reading back what the engine
 * actually rendered.
 *
 * THE IMPORTANT ONE IS `getRenderedEmail`.
 *
 * `core_engine.email_notification.content` stores the FULL rendered HTML body,
 * and it is written BEFORE the SMTP send — so the row exists with the body
 * intact even when delivery fails. That matters because SMTP on this tenant
 * loses ~5% of sends at batchSizeBilling=60 (measured 4.7% and 5.2% on two
 * independent runs). Asserting template content over IMAP would therefore flake
 * on roughly a third of multi-account runs through no fault of the test.
 *
 * So: assert CONTENT from the DB, and use IMAP only for what the DB cannot
 * answer — that a mail was actually delivered, and what was attached to it.
 *
 * Source of truth for the queries: notes/RUNBOOK-QA-all-events.md.
 */

/** One row of `core_engine.email_notification`. */
export interface NotificationRow {
  /**
   * The CORR-xxxxxx id. Load-bearing for evidence: every finding reported to the
   * team is anchored on it, and it is the only stable handle for a single
   * rendering. It was missing from both this interface and the SELECT, so five
   * failure messages across TS-01 and TS-05 were printing "undefined" in exactly
   * the place a reader needs to look the row up.
   */
  id: string;
  accountId: string;
  type: string;
  /** SUCCESS = rendered and SMTP accepted it. FAILED = rendered, SMTP refused. */
  status: 'SUCCESS' | 'FAILED' | string;
  email: string;
  content: string;
  createdDate: Date;
  entityId: string | null;
}

/** One raw KWH accumulator row, enough to restore it verbatim. */
export interface KwhRow {
  id: string;
  index: number;
  amount: string | number;
  startDate: string;
  endDate: string;
}

export interface EligibleAccountFilter {
  /** required_scheduledate the account must resolve to, YYYY-MM-DD. */
  scheduleDate: string;
  /** `insert_jobs` splits on this: BILL_CHECK takes CHECK, BILL_CC takes CREDIT_CARD. */
  paymentMethod?: 'CHECK' | 'CREDIT_CARD';
  /** Only accounts whose billing contact carries this address. */
  contactEmail?: string;
  /** True = only accounts with NO KWH accumulator rows (a clean slate for Event 3). */
  requireNoKwh?: boolean;
  limit?: number;
}

export interface EligibleAccount {
  accountId: string;
  balance: number;
  paymentMethod: string;
  kwhRows: number;
}

export class NotificationDbHelper {
  constructor(private db: DbHelper, private logger?: TestLogger) { }

  // ── Clock ───────────────────────────────────────────────────────────────

  /**
   * CCP date as YYYY-MM-DD.
   *
   * Read this, never `current_date`. The engine compares kWh accumulator
   * windows against the CCP clock (`core_config.ccp_time`, cached in Redis),
   * which on jasec-dev has run two months ahead of the Postgres clock. A query
   * written against `current_date` disagrees with the engine and every window
   * check silently misses.
   */
  async getCcpDate(): Promise<string> {
    const rows = await this.db.query<{ d: string }>(
      `SELECT to_char(ccptime::date, 'YYYY-MM-DD') AS d FROM core_config.ccp_time`,
    );
    if (!rows.length) throw new Error('NotificationDbHelper: core_config.ccp_time is empty');
    return rows[0].d;
  }

  // ── Per-account measurement ─────────────────────────────────────────────

  /**
   * X — `minimumtopupamount` for an account.
   *
   * NOTE the runbook's version of this query calls
   * `core_engine.get_usage_po_by_account_id(...)` to derive the second
   * argument. That function DOES NOT EXIST on jasec-dev, so the runbook query
   * errors out. The price-offer id is passed explicitly instead.
   *
   * TENANT CONFIG: defaults to the jasec-dev prepaid energy offer, override with
   * JASEC_PRICE_OFFER_ID per environment. A wrong offer id does not error — it
   * returns a different minimumtopupamount, which silently shifts every balance
   * band, so confirm it rather than trusting the default.
   */
  async getX(
    accountId: string,
    priceOfferId = process.env.JASEC_PRICE_OFFER_ID ?? 'P-100008',
  ): Promise<number> {
    const rows = await this.db.query<{ minimumtopupamount: string }>(
      `SELECT minimumtopupamount
         FROM core_engine.get_correspondence_data(NULL::varchar, $1::varchar, $2::varchar)`,
      [priceOfferId, accountId],
    );
    if (!rows.length || rows[0].minimumtopupamount == null) {
      throw new Error(`getX: no minimumtopupamount for ${accountId} (offer ${priceOfferId})`);
    }
    return Number(rows[0].minimumtopupamount);
  }

  /**
   * C — the account's cycle charge, from its most recent NON-ZERO invoice total.
   *
   * Not a constant: 2,077.20 and 2,319.30 were observed on neighbouring accounts
   * in the same run, so it must be measured per account.
   *
   * NON-ZERO IS THE LOAD-BEARING PART. Taking simply the latest invoice breaks:
   * an account that is already in debt gets invoiced 0.00 (observed on
   * ACT-100188, whose history reads 0.00 on 2026-11-09 then 2,319.30 on
   * 2026-10-09). C then measures 0, every derived band collapses, and the run
   * either aborts or stages meaningless balances.
   *
   * Returns null when the account has no non-zero invoice at all — the caller
   * decides whether to fall back to a tenant default or pick another account.
   */
  async getCycleCharge(accountId: string): Promise<number | null> {
    const rows = await this.db.query<{ total: string }>(
      `SELECT total FROM core_engine.invoice_unit
        WHERE accountid = $1 AND total > 0
        ORDER BY invoicedate DESC LIMIT 1`,
      [accountId],
    );
    return rows.length ? Number(rows[0].total) : null;
  }

  /** Every invoice total for an account, newest first — for diagnosing C. */
  async getInvoiceTotals(accountId: string, limit = 6): Promise<Array<{ id: string; total: number; date: string }>> {
    return this.db.query(
      `SELECT id, total, to_char(invoicedate, 'YYYY-MM-DD') AS date
         FROM core_engine.invoice_unit
        WHERE accountid = $1 ORDER BY invoicedate DESC LIMIT $2`,
      [accountId, limit],
    );
  }

  // ── Eligibility ─────────────────────────────────────────────────────────

  /**
   * required_scheduledate for an account. `BILL_CHECK` selects on EXACT
   * equality with the schedule's date, so this is the only date that will bill
   * this account.
   */
  async getRequiredScheduleDate(accountId: string): Promise<string | null> {
    const rows = await this.db.query<{ d: string }>(
      `SELECT to_char(nextaccountingdate + core_engine.get_future_cycle_date(accountid),
                      'YYYY-MM-DD') AS d
         FROM core_engine.billing_profile WHERE accountid = $1`,
      [accountId],
    );
    return rows.length ? rows[0].d : null;
  }

  /**
   * Accounts that a schedule on `scheduleDate` will actually bill.
   *
   * Every condition here is load-bearing — drop one and the run picks up
   * accounts it cannot bill, or misses the ones you staged:
   *   PREPAID + ACTIVE account, ACTIVE subscription, a PENDING bill unit,
   *   and required_scheduledate == scheduleDate.
   */
  async findEligibleAccounts(filter: EligibleAccountFilter): Promise<EligibleAccount[]> {
    const rows = await this.db.query<any>(
      `SELECT a.id                              AS "accountId",
              COALESCE(bub.amount, 0)           AS balance,
              pp.paymentmethod                  AS "paymentMethod",
              (SELECT count(*) FROM core_engine.balance_unit bu2
                 JOIN core_engine.balance_unit_accumulators k
                   ON k.id = bu2.id AND k.accumulatorid = 'KWH'
                WHERE bu2.accountid = a.id)     AS "kwhRows"
         FROM core_engine.account a
         JOIN core_engine.billing_profile bp ON bp.accountid = a.id
         JOIN core_engine.bill_unit bu       ON bu.accountid = a.id AND bu.status = 'PENDING'
         JOIN core_engine.payment_profile pp ON pp.accountid = a.id
         JOIN core_engine.subscription s     ON s.accountid = a.id AND s.status = 'ACTIVE'
         LEFT JOIN core_engine.balance_unit bal ON bal.accountid = a.id
         LEFT JOIN core_engine.balance_unit_balances bub
                ON bub.id = bal.id AND bub.currencyid = 'CRC'
        WHERE a.accountcategory = 'PREPAID'
          AND a.status = 'ACTIVE'
          AND bp.nextaccountingdate + core_engine.get_future_cycle_date(a.id) = $1::date
          AND ($2::varchar IS NULL OR pp.paymentmethod = $2::varchar)
          AND ($3::varchar IS NULL OR EXISTS (
                SELECT 1 FROM core_engine.contact ct
                 WHERE ct.accountid = a.id AND ct.email = $3::varchar))
        ORDER BY a.id
        LIMIT $4`,
      [
        filter.scheduleDate,
        filter.paymentMethod ?? null,
        filter.contactEmail ?? null,
        filter.limit ?? 50,
      ],
    );

    const mapped: EligibleAccount[] = rows.map((r) => ({
      accountId: r.accountId,
      balance: Number(r.balance),
      paymentMethod: r.paymentMethod,
      kwhRows: Number(r.kwhRows),
    }));

    return filter.requireNoKwh ? mapped.filter((a) => a.kwhRows === 0) : mapped;
  }

  // ── Staging ─────────────────────────────────────────────────────────────

  /**
   * Set the CRC balance.
   *
   * The `currencyid` filter is deliberate and must not be dropped: the credit
   * profile also carries a USD line, and an unfiltered UPDATE overwrites both.
   *
   * Stage in AUTOCOMMIT. Inside an uncommitted transaction this verifies
   * perfectly, then vanishes — and the open transaction holds row locks on
   * `balance_unit_balances`, so a concurrent write to the same account blocks
   * until the client gives up, which presents as an application hang.
   */
  async setCrcBalance(accountId: string, amount: number): Promise<void> {
    const rows = await this.db.query(
      `UPDATE core_engine.balance_unit_balances bub SET amount = $2
         FROM core_engine.balance_unit bu
        WHERE bu.id = bub.id AND bub.currencyid = 'CRC' AND bu.accountid = $1
        RETURNING bub.amount`,
      [accountId, amount],
    );
    if (rows.length !== 1) {
      throw new Error(
        `setCrcBalance: expected 1 CRC row for ${accountId}, updated ${rows.length}. ` +
        `0 means no CRC balance row exists; >1 means multiple balance units.`,
      );
    }
    this.logger?.log(`staged ${accountId} CRC balance -> ${amount}`);
  }

  async getCrcBalance(accountId: string): Promise<number | null> {
    const rows = await this.db.query<{ amount: string }>(
      `SELECT bub.amount FROM core_engine.balance_unit_balances bub
         JOIN core_engine.balance_unit bu ON bu.id = bub.id
        WHERE bu.accountid = $1 AND bub.currencyid = 'CRC'`,
      [accountId],
    );
    return rows.length ? Number(rows[0].amount) : null;
  }

  /**
   * The subscription's current status, or null when the account has none.
   *
   * Needed because Event 5 (Servicio Suspendido) fires on the PROVISIONING
   * CALLBACK confirming the disconnect reached the meter -- not at breach, and
   * not when CREDIT_LIMIT_ACTIONS runs (amended case 5.1). There is no callback
   * trail to wait on (core_oms.order_provisioning is an empty stub), so the
   * observable proof that the callback landed is the subscription actually
   * moving to SUSPENDED. Demanding the email without checking this reds a run
   * whenever no suspension was ever due.
   */
  async getSubscriptionStatus(accountId: string): Promise<string | null> {
    const rows = await this.db.query<{ status: string }>(
      `SELECT status FROM core_engine.subscription WHERE accountid = $1
        ORDER BY id DESC LIMIT 1`,
      [accountId],
    );
    return rows.length ? rows[0].status : null;
  }

  /**
   * Replace the account's KWH accumulator rows with a single row of `kwh`
   * spanning [startDate, endDate).
   *
   * `enddate` is EXCLUSIVE and the window must bracket the CCP date, not the
   * Postgres date. An account with no KWH rows at all renders the <=100 branch
   * with NO balance figure (that is defect 3.5), so set the band explicitly
   * rather than hunting for accounts that happen to have one.
   */
  async setKwh(accountId: string, kwh: number, startDate: string, endDate: string): Promise<void> {
    await this.db.query(
      `DELETE FROM core_engine.balance_unit_accumulators bua
        USING core_engine.balance_unit bu
        WHERE bu.id = bua.id AND bua.accumulatorid = 'KWH' AND bu.accountid = $1`,
      [accountId],
    );
    const inserted = await this.db.query(
      `INSERT INTO core_engine.balance_unit_accumulators
              (id, index, accumulatorid, amount, startdate, enddate)
       SELECT bu.id, 1, 'KWH', $2, $3::date, $4::date
         FROM core_engine.balance_unit bu
        WHERE bu.accountid = $1
       RETURNING id`,
      [accountId, kwh, startDate, endDate],
    );
    if (!inserted.length) {
      throw new Error(`setKwh: ${accountId} has no balance_unit to attach a KWH row to`);
    }
    this.logger?.log(`staged ${accountId} KWH -> ${kwh} over [${startDate}, ${endDate})`);
  }

  /**
   * kWh the engine will actually see, evaluated against the CCP date.
   *
   * A NULL result means no row brackets the CCP date, so the code falls back to
   * the newest window rather than using your band — check this before
   * concluding a missing Event 3 is a defect.
   */
  async getKwhInWindow(accountId: string, ccpDate: string): Promise<number | null> {
    const rows = await this.db.query<{ kwh: string | null }>(
      `SELECT sum(bua.amount) FILTER (
                WHERE bua.startdate::date <= $2::date AND $2::date < bua.enddate::date
              ) AS kwh
         FROM core_engine.balance_unit bu
         LEFT JOIN core_engine.balance_unit_accumulators bua
                ON bua.id = bu.id AND bua.accumulatorid = 'KWH'
        WHERE bu.accountid = $1`,
      [accountId, ccpDate],
    );
    const v = rows[0]?.kwh;
    return v == null ? null : Number(v);
  }

  /**
   * Accounts that can actually produce a threshold email on a given schedule date.
   *
   * SELECTS ON THE CREDIT PROFILE, which is the real cause. An account only gets a
   * low-balance warning if its subscription resolves to a credit profile whose CRC
   * row has a `valuethreshold`; without one the credit check returns before the
   * threshold logic ever runs. Dev confirmed 2026-08-14 that production MUST
   * assign a profile carrying -4000|-2000.
   *
   * This replaces an earlier heuristic that picked accounts which had fired
   * BEFORE. That was a correlation, not a cause, and it produced an invalid bug
   * report: 166 prepaid accounts on dev have creditprofilename NULL and are
   * therefore silent no matter how they are staged, which looked like a product
   * defect. Proved by A/B on JS-100199 — the same account fires on Default Credit
   * Profile and goes silent on Prepaid Energy Profile (valuethreshold NULL).
   *
   * So an account this query returns is genuinely capable; one it omits would be
   * bad test data, not a defect. `fires DESC` only orders the survivors.
   */
  /**
   * The account's OWN credit-limit thresholds, read from its assigned profile.
   *
   * Returns null when the account has no profile, or its profile has no CRC
   * `valuethreshold` — both mean no warning can ever fire, which is test-data
   * invalid rather than a defect. Callers should fail fast on null instead of
   * reporting the resulting silence as a bug.
   *
   * Stored as "-4000|-2000"; the more negative value is the HIGH tier.
   */
  async getAccountThresholds(
    accountId: string,
  ): Promise<{ base: number; high: number; raw: string; profile: string } | null> {
    const rows = await this.db.query<{ v: string | null; profile: string | null }>(
      `SELECT cps.valuethreshold AS v, cp.name AS profile
         FROM core_engine.subscription s
         JOIN core_config.credit_profile  cp  ON cp.name = s.creditprofilename
         JOIN core_config.credit_profiles cps ON cps.id = cp.id AND cps.currency = 'CRC'
        WHERE s.accountid = $1`,
      [accountId],
    );
    const raw = rows[0]?.v;
    if (!raw) return null;
    const parts = raw.split('|').map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    if (parts.length < 2) return null;
    return { high: parts[0], base: parts[parts.length - 1], raw, profile: rows[0].profile ?? '(unnamed)' };
  }


  async findThresholdCapableAccounts(
    scheduleDate: string,
    limit = 12,
  ): Promise<Array<{ accountId: string; fires: number; thresholds: string }>> {
    return this.db.query(
      `SELECT a.id AS "accountId",
              cps.valuethreshold AS thresholds,
              (SELECT count(*)::int FROM core_engine.email_notification n
                WHERE n.accountid = a.id AND n.type = 'CREDIT_THRESHOLD_BREACH') AS fires
         FROM core_engine.account a
         JOIN core_engine.billing_profile bp ON bp.accountid = a.id
         JOIN core_engine.bill_unit bu  ON bu.accountid = a.id AND bu.status = 'PENDING'
         JOIN core_engine.subscription s ON s.accountid = a.id AND s.status = 'ACTIVE'
         JOIN core_config.credit_profile  cp  ON cp.name = s.creditprofilename
         JOIN core_config.credit_profiles cps ON cps.id = cp.id AND cps.currency = 'CRC'
        WHERE a.accountcategory = 'PREPAID'
          AND a.status = 'ACTIVE'
          AND cps.valuethreshold IS NOT NULL
          AND bp.nextaccountingdate + core_engine.get_future_cycle_date(a.id) = $1::date
        ORDER BY fires DESC, a.id
        LIMIT $2`,
      [scheduleDate, limit],
    );
  }

  /**
   * This account's raw KWH accumulator rows — capture before staging so
   * `restoreKwhRows` can put them back exactly. `getKwhInWindow` returns only a
   * sum for the current window, which is not enough to restore.
   */
  async getKwhRows(accountId: string): Promise<KwhRow[]> {
    return this.db.query<KwhRow>(
      `SELECT bua.id, bua.index, bua.amount,
              to_char(bua.startdate, 'YYYY-MM-DD') AS "startDate",
              to_char(bua.enddate,   'YYYY-MM-DD') AS "endDate"
         FROM core_engine.balance_unit_accumulators bua
         JOIN core_engine.balance_unit bu ON bu.id = bua.id
        WHERE bu.accountid = $1 AND bua.accumulatorid = 'KWH'
        ORDER BY bua.index`,
      [accountId],
    );
  }

  /** Put back what `getKwhRows` captured. Clears first, so it is idempotent. */
  async restoreKwhRows(accountId: string, rows: KwhRow[]): Promise<void> {
    await this.clearKwh(accountId);
    for (const r of rows) {
      await this.db.query(
        `INSERT INTO core_engine.balance_unit_accumulators
                (id, index, accumulatorid, amount, startdate, enddate)
         VALUES ($1, $2, 'KWH', $3, $4::date, $5::date)`,
        [r.id, r.index, r.amount, r.startDate, r.endDate],
      );
    }
    this.logger?.log(`restored ${accountId} KWH rows (${rows.length})`);
  }

  /**
   * Stage SEVERAL KWH windows on one account — for cases 3.7/3.8/3.9.
   *
   * `setKwh` deletes and inserts exactly one row, so until now every test ran
   * with a single accumulator window. That left the most consequential question
   * about the tier untested: does the engine decide the tier from the CURRENT
   * cycle, or from every window it can see?
   *
   * kWh accrues monthly, so if the tier summed all windows then after a few
   * cycles every customer would sit permanently in the top tier and the email
   * would always show the IVA paragraph. It cannot be observed on a fresh
   * account, which is what every other test uses.
   *
   * Windows are half-open, `startdate <= ccp < enddate`, matching
   * `getKwhInWindow`. Index is 1-based and must be distinct per row.
   */
  async setKwhWindows(
    accountId: string,
    windows: Array<{ kwh: number; startDate: string; endDate: string }>,
  ): Promise<void> {
    if (!windows.length) throw new Error('setKwhWindows: no windows given');
    await this.clearKwh(accountId);
    for (const [i, w] of windows.entries()) {
      const inserted = await this.db.query(
        `INSERT INTO core_engine.balance_unit_accumulators
                (id, index, accumulatorid, amount, startdate, enddate)
         SELECT bu.id, $2, 'KWH', $3, $4::date, $5::date
           FROM core_engine.balance_unit bu
          WHERE bu.accountid = $1
         RETURNING id`,
        [accountId, i + 1, w.kwh, w.startDate, w.endDate],
      );
      if (!inserted.length) {
        throw new Error(`setKwhWindows: ${accountId} has no balance_unit to attach a KWH row to`);
      }
    }
    this.logger?.log(
      `staged ${accountId} KWH windows -> ` +
      windows.map((w) => `${w.kwh} over [${w.startDate}, ${w.endDate})`).join(' + '),
    );
  }

  /** Delete this account's KWH rows — the restore step for `setKwh`. */
  async clearKwh(accountId: string): Promise<number> {
    const rows = await this.db.query(
      `DELETE FROM core_engine.balance_unit_accumulators bua
        USING core_engine.balance_unit bu
        WHERE bu.id = bua.id AND bua.accumulatorid = 'KWH' AND bu.accountid = $1
       RETURNING bua.id`,
      [accountId],
    );
    return rows.length;
  }

  // ── SMTP batch size ─────────────────────────────────────────────────────

  /**
   * `batchSizeBilling` — raise before a multi-account run.
   *
   * At the default of 5, Office365 rejects the parallel SMTP connections with
   * `432 4.3.2 Concurrent connections limit exceeded` and the notifications
   * land as FAILED: rendered fine, never delivered. No pod restart needed,
   * `insert_jobs` reads this directly in SQL.
   */
  async getBatchSizeBilling(): Promise<string> {
    const rows = await this.db.query<{ value: string }>(
      `SELECT value FROM core_config.ccp_properties WHERE property = 'batchSizeBilling'`,
    );
    return rows[0]?.value ?? '(unset)';
  }

  async setBatchSizeBilling(value: number): Promise<void> {
    await this.db.query(
      `UPDATE core_config.ccp_properties SET value = $1 WHERE property = 'batchSizeBilling'`,
      [String(value)],
    );
  }

  // ── Schedule slots ──────────────────────────────────────────────────────

  /**
   * Schedules already occupying a date.
   *
   * `job_schedule` is UNIQUE(schedulefrequency, scheduledate) and only DAILY
   * and SCHEDULED exist — so a date has exactly TWO slots. Both taken means no
   * run is possible on that date until one is deleted (children first).
   */
  async getScheduleSlots(date: string): Promise<Array<{ id: string; frequency: string; status: string }>> {
    return this.db.query(
      `SELECT id, schedulefrequency AS frequency, status
         FROM core_engine.job_schedule WHERE scheduledate::date = $1::date
        ORDER BY schedulefrequency`,
      [date],
    );
  }

  /**
   * Reclaim a spent `job_schedule` slot so a FAILED run can be retried on the
   * same date. Returns the ids actually deleted.
   *
   * WHY THIS EXISTS. `getScheduleSlots` / `findScheduleDateCandidates` only ever
   * SKIP a taken date and walk forward. That leaves a failed run's date burned
   * permanently: measured on jasec-dev 2026-08-21, 14 of 42 scheduled dates were
   * at 2/2 and 11 of those held an ERROR slot — 11 dates lost to failures, not to
   * work. `ts-05` can already hard-fail with "No date has a free job_schedule
   * slot AND N threshold-capable accounts". This hands those dates back.
   *
   * WHAT IT DOES NOT DO — read before using it. Freeing the slot does NOT un-bill
   * anything. `bill_unit` rows survive the delete (131-133 per month on
   * jasec-dev), so re-running a date bills only accounts that were NOT billed the
   * first time. This is a retry-after-failure tool, not a way to re-bill an
   * account or to make a billing run idempotent.
   *
   * WHY THE DELETE ORDER IS FIXED. `job_schedule_list_id_fkey` has NO
   * ON DELETE CASCADE (verified against the live schema), so children must go
   * first or the parent delete throws. Nothing else in the schema references
   * either table, so these two statements are the complete cleanup — no orphans.
   * Deleting the children also frees their names, which matters because
   * `job_schedule_list__name` is UNIQUE across the WHOLE table.
   *
   * @param statuses Which slots may be reclaimed. Default ERROR / SUSPENDED /
   *   PENDING. `COMPLETED` is excluded on purpose: it already billed its
   *   accounts, so reclaiming it buys nothing and destroys the audit trail.
   *   `PROCESSING` is excluded and must stay excluded — that is a live job, and
   *   deleting a running schedule's rows is the one way this helper could break
   *   something that currently works.
   */
  async freeScheduleSlot(
    date: string,
    opts: { frequency?: string; statuses?: string[] } = {},
  ): Promise<Array<{ id: string; frequency: string; status: string }>> {
    const allowed = opts.statuses ?? ['ERROR', 'SUSPENDED', 'PENDING'];

    // Never reclaimable, whatever the caller passes.
    const forbidden = allowed.filter((s) => s === 'PROCESSING');
    if (forbidden.length) {
      throw new Error(
        'freeScheduleSlot: refusing to delete a PROCESSING schedule — that is a live job.',
      );
    }

    const slots = (await this.getScheduleSlots(date)).filter(
      (s) =>
        allowed.includes(s.status) &&
        (opts.frequency ? s.frequency === opts.frequency : true),
    );

    const deleted: Array<{ id: string; frequency: string; status: string }> = [];
    for (const slot of slots) {
      // Children first — the FK is not ON DELETE CASCADE.
      await this.db.query(`DELETE FROM core_engine.job_schedule_list WHERE id = $1`, [slot.id]);
      await this.db.query(`DELETE FROM core_engine.job_schedule      WHERE id = $1`, [slot.id]);
      deleted.push(slot);
      // Logged, not silent: this is the audit trail for a reclaimed billing date.
      this.logger?.log(
        `freed job_schedule slot ${slot.id} on ${date} (${slot.frequency}, was ${slot.status})`,
      );
    }

    if (!deleted.length) {
      this.logger?.log(
        `no reclaimable job_schedule slot on ${date} ` +
        `(allowed: ${allowed.join('/')}; present: ${(await this.getScheduleSlots(date))
          .map((s) => `${s.frequency}:${s.status}`)
          .join(', ') || 'none'})`,
      );
    }
    return deleted;
  }

  /**
   * Dates a run could actually use, best first.
   *
   * This is what makes the suite one-button: the schedule date is NOT a
   * parameter a human has to look up. A date qualifies when
   *   - at least `minAccounts` accounts resolve their required_scheduledate to it,
   *   - it is on or after the current CCP date (the clock only moves forward), and
   *   - the frequency slot we intend to use is free.
   *
   * Returns them MOST-ACCOUNTS-FIRST. Ranking by count rather than by proximity
   * because the clock can be moved either way here, so the best date is the one
   * with the most un-billed accounts, not the nearest one.
   */
  async findScheduleDateCandidates(opts: {
    frequency: string;
    /** Optional floor. Omit to consider PAST dates too — the CCP clock may be
     *  moved backward freely on dev/preprod, and older cycles often have far
     *  more un-billed accounts than the current one. */
    fromDate?: string;
    minAccounts?: number;
    paymentMethod?: 'CHECK' | 'CREDIT_CARD';
    contactEmail?: string;
    /**
     * Opt in to reclaiming a date whose slot was burned by a FAILED run, instead
     * of skipping it. Off by default, so the behaviour without it is unchanged.
     *
     * Only ERROR / SUSPENDED / PENDING slots are reclaimed — see
     * `freeScheduleSlot`. A COMPLETED slot is still skipped, because its accounts
     * really were billed and re-running the date would bill nothing.
     */
    reclaim?: boolean;
  }): Promise<Array<{ date: string; eligibleCount: number }>> {
    const rows = await this.db.query<{ d: string; n: string }>(
      `SELECT to_char(bp.nextaccountingdate + core_engine.get_future_cycle_date(a.id),
                      'YYYY-MM-DD') AS d,
              count(*) AS n
         FROM core_engine.account a
         JOIN core_engine.billing_profile bp ON bp.accountid = a.id
         JOIN core_engine.bill_unit bu       ON bu.accountid = a.id AND bu.status = 'PENDING'
         JOIN core_engine.payment_profile pp ON pp.accountid = a.id
         JOIN core_engine.subscription s     ON s.accountid = a.id AND s.status = 'ACTIVE'
        WHERE a.accountcategory = 'PREPAID'
          AND a.status = 'ACTIVE'
          AND ($1::varchar IS NULL OR pp.paymentmethod = $1::varchar)
          AND ($2::varchar IS NULL OR EXISTS (
                SELECT 1 FROM core_engine.contact ct
                 WHERE ct.accountid = a.id AND ct.email = $2::varchar))
          AND ($3::date IS NULL OR
               bp.nextaccountingdate + core_engine.get_future_cycle_date(a.id) >= $3::date)
        GROUP BY 1
        HAVING count(*) >= $4
        ORDER BY count(*) DESC, 1`,
      [opts.paymentMethod ?? null, opts.contactEmail ?? null, opts.fromDate ?? null, opts.minAccounts ?? 7],
    );

    const usable: Array<{ date: string; eligibleCount: number }> = [];
    for (const r of rows) {
      let slots = await this.getScheduleSlots(r.d);
      if (slots.some((s) => s.frequency === opts.frequency)) {
        // Slot spent. Without `reclaim` this is terminal for the date, which is
        // how a failed run burns a date permanently.
        if (!opts.reclaim) continue;
        const freed = await this.freeScheduleSlot(r.d, { frequency: opts.frequency });
        if (!freed.length) continue;               // COMPLETED or PROCESSING — genuinely spent
        slots = await this.getScheduleSlots(r.d);
        if (slots.some((s) => s.frequency === opts.frequency)) continue; // belt and braces
      }
      usable.push({ date: r.d, eligibleCount: Number(r.n) });
    }
    return usable;
  }

  /** Any `ccp_properties` value, raw. Returns null when the property is absent. */
  async getCcpProperty(property: string): Promise<string | null> {
    const rows = await this.db.query<{ value: string }>(
      `SELECT value FROM core_config.ccp_properties WHERE lower(property) = lower($1)`,
      [property],
    );
    return rows[0]?.value ?? null;
  }

  /**
   * How the engine handles a credit-limit breach.
   *
   * `throwCreditLimitBreachException` decides the entire shape of Events 4 and 5:
   *
   *   true  (JASEC)  — the breach is thrown as an exception, so the account's
   *                    billing transaction ROLLS BACK. No CREDIT_LIMIT_BREACH row,
   *                    no invoice, balance unchanged, and the subscription is NOT
   *                    suspended — there is no debt left for CREDIT_LIMIT_ACTIONS
   *                    to act on. The two emails are still delivered, because a
   *                    send cannot be rolled back. Dev confirmed this is by design
   *                    (2026-08-13).
   *   false (CoopeG) — no exception, so the charge persists: row written, invoice
   *                    created, balance goes positive, and the account is then
   *                    genuinely suspended.
   *
   * Read it rather than assuming, so the assertions match the configuration
   * actually in force — and flip automatically if it is ever changed.
   */
  async getCreditLimitBreachBehaviour(): Promise<{ throwsException: boolean; raw: string }> {
    const raw = (await this.getCcpProperty('throwCreditLimitBreachException')) ?? '(unset)';
    return { throwsException: raw.trim().toLowerCase() === 'true', raw };
  }

  // ── Recipient attribution (plus-addressing) ─────────────────────────────

  /**
   * Build a plus-addressed recipient that identifies an account.
   *
   *   qa@example.com  ->  qa+ACT100188@example.com
   *
   * WHY: Events 4 and 5 are otherwise unverifiable. Their `email_notification`
   * row is rolled back (defect 4.2), so the database shows nothing — and unlike
   * BALANCE_TOPUP, the CREDIT_LIMIT_BREACH and SUSPEND_SUBSCRIPTION templates
   * carry NO account number in the body, so a delivered email cannot be tied
   * back to an account either.
   *
   * Plus-addressing puts the account id in the `To:` header instead, which makes
   * those events attributable WITHOUT changing any customer-facing template. The
   * alternative — asking for the account number to be added to approved customer
   * copy purely so tests can read it — is the wrong trade, and JASEC Phase 1 has
   * one meter per account anyway, so there is no customer-facing case for it.
   *
   * The hyphen is stripped from the tag: hyphens are legal in a local part, but
   * dropping them keeps the tag a single alphanumeric token and avoids any
   * downstream parsing surprises.
   */
  static plusAddress(baseEmail: string, accountId: string): string {
    const at = baseEmail.indexOf('@');
    if (at < 0) throw new Error(`plusAddress: "${baseEmail}" is not an address`);
    const local = baseEmail.slice(0, at).split('+')[0];
    const tag = accountId.replace(/[^A-Za-z0-9]/g, '');
    return `${local}+${tag}${baseEmail.slice(at)}`;
  }

  /** The tag that `plusAddress` would produce, for matching a To: header. */
  static plusTag(accountId: string): string {
    return `+${accountId.replace(/[^A-Za-z0-9]/g, '')}`;
  }

  async getContactEmail(accountId: string): Promise<string | null> {
    const rows = await this.db.query<{ email: string }>(
      `SELECT email FROM core_engine.contact WHERE accountid = $1 ORDER BY id LIMIT 1`,
      [accountId],
    );
    return rows[0]?.email ?? null;
  }

  /**
   * Point an account's notifications at a plus-addressed recipient.
   *
   * REFUSES unless the current address is already `expectedCurrent` (the
   * monitored test mailbox). Rewriting a real customer's contact email would
   * redirect their mail, so this must never fire on an account we do not own the
   * inbox for. Returns the original so the caller can restore it.
   */
  async setContactEmailToPlusAddress(
    accountId: string,
    expectedCurrent: string,
  ): Promise<{ original: string; applied: string } | null> {
    const current = await this.getContactEmail(accountId);
    if (!current || current.toLowerCase() !== expectedCurrent.toLowerCase()) {
      this.logger?.log(
        `skipping plus-address for ${accountId}: contact is "${current}", ` +
        `not the monitored mailbox "${expectedCurrent}"`,
      );
      return null;
    }
    const applied = NotificationDbHelper.plusAddress(current, accountId);
    const rows = await this.db.query(
      `UPDATE core_engine.contact SET email = $2 WHERE accountid = $1 RETURNING email`,
      [accountId, applied],
    );
    if (!rows.length) throw new Error(`setContactEmailToPlusAddress: no contact row for ${accountId}`);
    return { original: current, applied };
  }

  /** Restore a contact email captured by `setContactEmailToPlusAddress`. */
  async restoreContactEmail(accountId: string, original: string): Promise<void> {
    await this.db.query(
      `UPDATE core_engine.contact SET email = $2 WHERE accountid = $1`,
      [accountId, original],
    );
  }

  /**
   * Is fiscal stamping enabled, and is the supporting config actually present?
   *
   * `ccp_properties.pacEnabled` is the switch (per the Embrix team). On jasec-dev
   * it reads `false`.
   *
   * `configured` matters separately: flipping the switch is NOT enough, because
   * the PAC config tables are empty (`pac_product_codes`, `folio_response`,
   * `folio_response_files` — all 0 rows) and no PAC interaction has ever been
   * recorded (`pac_interface_record`, 0 rows). So a run with `pacEnabled = true`
   * and no config would not stamp either, and reporting that as a stamping defect
   * would be wrong.
   */
  async getStampingState(): Promise<{
    enabled: boolean;
    rawValue: string;
    configured: boolean;
    configCounts: Record<string, number>;
  }> {
    const flag = await this.db.query<{ value: string }>(
      `SELECT value FROM core_config.ccp_properties WHERE lower(property) = 'pacenabled'`,
    );
    const rawValue = flag[0]?.value ?? '(unset)';

    const counts: Record<string, number> = {};
    for (const [key, table] of Object.entries({
      pacProductCodes: 'core_config.pac_product_codes',
      folioResponse: 'core_config.folio_response',
      folioResponseFiles: 'core_config.folio_response_files',
      pacInterfaceRecords: 'core_engine.pac_interface_record',
    })) {
      const r = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
      counts[key] = Number(r[0].n);
    }

    return {
      enabled: rawValue.trim().toLowerCase() === 'true',
      rawValue,
      configured: counts.pacProductCodes > 0 && counts.folioResponse > 0,
      configCounts: counts,
    };
  }

  /**
   * Invoice artifacts produced by a run — the Event 7 evidence.
   *
   * `invoicebase64pdf` is NULL on every invoice on this tenant, so the PDF is not
   * in the database: `filepath` points at it and retrieval needs the document
   * service. `foliostatus` is the per-invoice stamping signal (null = never
   * stamped, STAMPED = registered with the tax authority) and is a better
   * indicator than any global config flag.
   */
  async getInvoiceArtifacts(opts: { ccpDate?: string; sinceMinutes?: number } = {}): Promise<Array<{
    id: string; accountId: string; total: number;
    filepath: string | null; folioId: string | null; folioStatus: string | null;
    hasBase64Pdf: boolean;
  }>> {
    return this.db.query(
      `SELECT id,
              accountid                        AS "accountId",
              total,
              filepath,
              folioid                          AS "folioId",
              foliostatus                      AS "folioStatus",
              (invoicebase64pdf IS NOT NULL)   AS "hasBase64Pdf"
         FROM core_engine.invoice_unit
        WHERE ($1::date IS NULL OR invoicedate::date = $1::date)
          AND ($2::int  IS NULL OR createddate > now() - ($2 || ' minutes')::interval)
        ORDER BY id DESC`,
      [opts.ccpDate ?? null, opts.ccpDate ? null : (opts.sinceMinutes ?? 120)],
    );
  }

  /**
   * Clear stale `BILL_CHECK` rows before creating a schedule, so the new run
   * does not collide on batch ids with a previous one.
   */
  async clearStaleJobs(type = 'BILL_CHECK'): Promise<number> {
    const rows = await this.db.query(
      `DELETE FROM core_engine.jobs WHERE type = $1 RETURNING id`,
      [type],
    );
    return rows.length;
  }

  // ── Reading back what the engine rendered ───────────────────────────────

  /**
   * Highest notification id — the watermark for "everything after this is mine".
   *
   * THIS IS THE ONLY RELIABLE WAY TO SCOPE A RUN. `createddate` is stamped from
   * the CCP clock, not wall time, so on a tenant parked in the future EVERY row
   * satisfies "created in the last N minutes" — which made a single Event 3
   * email read as two and a single event type read as four. A CCP-date filter is
   * no better: 479 rows are already stamped 2026-09-09, so a run on that date
   * would count all of them.
   *
   * ids are `CORR-` plus a fixed-width counter, so string comparison orders them
   * correctly. Capture this BEFORE the run and pass it as `afterId`.
   */
  async getMaxNotificationId(): Promise<string> {
    const rows = await this.db.query<{ mx: string | null }>(
      'SELECT max(id) AS mx FROM core_engine.email_notification',
    );
    return rows[0]?.mx ?? '';
  }

  async getNotifications(opts: {
    accountIds?: string[];
    type?: string;
    sinceMinutes?: number;
    /** Watermark from getMaxNotificationId(). Strongly preferred over sinceMinutes. */
    afterId?: string;
  } = {}): Promise<NotificationRow[]> {
    const rows = await this.db.query<any>(
      `SELECT id, accountid AS "accountId", type, status, email, content,
              createddate AS "createdDate", entityid AS "entityId"
         FROM core_engine.email_notification
        WHERE ($1::varchar[] IS NULL OR accountid = ANY($1::varchar[]))
          AND ($2::varchar   IS NULL OR type = $2::varchar)
          AND ($3::int       IS NULL OR createddate > now() - ($3 || ' minutes')::interval)
          AND ($4::varchar   IS NULL OR id > $4::varchar)
        ORDER BY id DESC`,
      [opts.accountIds ?? null, opts.type ?? null, opts.sinceMinutes ?? null, opts.afterId || null],
    );
    return rows.map((r) => ({ ...r, createdDate: new Date(r.createdDate) }));
  }

  /**
   * Wait until notifications stop arriving.
   *
   * Notifications are written asynchronously AFTER the job returns, so asserting
   * straight after `processSchedule` reads a half-populated table and reports
   * missing events that are merely late. The runbook handles this with a fixed
   * `sleep 120`; waiting for a quiet period is faster on a small run and safer
   * on a large one.
   *
   * Returns the row count seen in the window.
   */
  async waitForNotificationsToSettle(opts: {
    sinceMinutes?: number;
    afterId?: string;
    quietMs?: number;
    timeoutMs?: number;
    onTick?: (count: number) => void;
  } = {}): Promise<number> {
    const quietMs = opts.quietMs ?? 30_000;
    const timeoutMs = opts.timeoutMs ?? 420_000;
    const deadline = Date.now() + timeoutMs;

    let last = -1;
    let stableSince = Date.now();

    for (; ;) {
      const count = (await this.getNotifications({
        sinceMinutes: opts.afterId ? undefined : (opts.sinceMinutes ?? 120),
        afterId: opts.afterId,
      })).length;
      if (count !== last) {
        last = count;
        stableSince = Date.now();
        opts.onTick?.(count);
      } else if (Date.now() - stableSince >= quietMs) {
        return count;
      }
      if (Date.now() > deadline) return count;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  /**
   * Event 3's pass condition is the COUNT, not the presence.
   *
   * 2 is a real regression — `isThresholdForTier` failed to suppress the
   * threshold the account's tier does not expect. 0 means the crossing never
   * happened, or the tier suppressed it (check getKwhInWindow first).
   */
  async countNotifications(accountId: string, type: string, afterId: string): Promise<number> {
    const rows = await this.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM core_engine.email_notification
        WHERE accountid = $1 AND type = $2 AND id > $3`,
      [accountId, type, afterId],
    );
    return Number(rows[0].n);
  }

  /**
   * Configured subject line for a notification type, per tenant template config.
   *
   * READ THE SUBJECT FROM HERE, NOT FROM THE BODY. The `<title>` tag inside the
   * rendered HTML is whatever the template author wrote in the head and is not
   * always the subject SMTP sends — BALANCE_TOPUP renders `<title>Jasec -
   * Recarga</title>` while its configured subject is `Jasec - Servicio
   * Eléctrico Prepago - Recarga`. They agree on the other eight templates,
   * which makes this an easy and silent thing to get wrong.
   *
   * Filtered to PREPAID/ACTIVE deliberately: the table also carries generic
   * English rows for SUSPEND_SUBSCRIPTION and RESUME_SUBSCRIPTION ("Service
   * suspended") on other account categories.
   */
  async getConfiguredSubject(type: BillingEvent | string): Promise<string | null> {
    const rows = await this.db.query<{ emailsubject: string }>(
      `SELECT emailsubject FROM core_config.correspondence_template_list
        WHERE type = $1 AND accountcategory = 'PREPAID' AND status = 'ACTIVE'
        ORDER BY index DESC LIMIT 1`,
      [type],
    );
    return rows.length ? rows[0].emailsubject : null;
  }

  /** Deployed template filename for a type, e.g. `jasec_balance_topup_v4.html`. */
  async getTemplateFile(type: BillingEvent | string): Promise<string | null> {
    const rows = await this.db.query<{ filepath: string }>(
      `SELECT filepath FROM core_config.correspondence_template_list
        WHERE type = $1 AND accountcategory = 'PREPAID' AND status = 'ACTIVE'
        ORDER BY index DESC LIMIT 1`,
      [type],
    );
    const p = rows[0]?.filepath;
    return p ? p.split('/').pop()!.trim() : null;
  }

  /**
   * The rendered notification as a ParsedEmail, straight from the DB.
   *
   * Same object the IMAP path produces, so every FieldCheck works unchanged
   * against either source. `receivedAt` is the row's createddate and `to` is
   * the address the engine addressed it to — note that a FAILED row still
   * carries both, which is the point.
   */
  async getRenderedEmail(
    accountId: string,
    type: BillingEvent | string,
    scope: { sinceMinutes?: number; afterId?: string } = {},
  ): Promise<{ email: ParsedEmail; row: NotificationRow } | null> {
    const rows = await this.getNotifications({ accountIds: [accountId], type, ...scope });
    if (!rows.length) return null;
    const subject = await this.getConfiguredSubject(type);
    return { email: this.toParsedEmail(rows[0], subject ?? ''), row: rows[0] };
  }

  /**
   * Build a ParsedEmail from a notification row.
   *
   * `subject` must be supplied from `getConfiguredSubject` — it is not
   * recoverable from the body. Exposed for the smoke test, which batches the
   * subject lookup rather than repeating it per row.
   */
  toParsedEmail(row: NotificationRow, subject: string): ParsedEmail {
    const html = row.content ?? '';
    return new ParsedEmail(
      subject,
      '(db)',
      row.email ?? '',
      row.createdDate,
      html,
      htmlToText(html),
      extractImageSrcs(html),
    );
  }
}
