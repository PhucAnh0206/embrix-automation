import { DbHelper } from './db.helper';

/**
 * The journal side of the accounting extract — the evidence GraphQL does not
 * expose.
 *
 * `searchEbsExtract` shows what the extract PRODUCED. It says nothing about what
 * the extract CONSUMED: which `core_revenue.revenue_journal` rows were swept up,
 * that they moved BILLED -> POSTED, and that they now carry the batch id. That
 * chain is the whole point of point 10 of the guide, and it only exists in the
 * database. Needs the AWS VPN; the GraphQL half deliberately does not.
 *
 * THE TRAP THAT BREAKS THIS ENTIRE SUITE IF YOU MISS IT — READ THIS ONE.
 *
 *   node-postgres returns a Postgres `date` column as a JS Date, which is then
 *   rendered in the CLIENT's timezone. On this machine `ccp_time` of 2026-09-14
 *   comes back as `2026-09-13T17:00:00.000Z` — one day early. Every date in this
 *   feature (inputdate, revenueenddate, gldate, accountingdate) is a bare `date`,
 *   and the feature under test IS a one-day offset. Reading them as Dates makes
 *   a correct extract look off-by-one and an off-by-one extract look correct.
 *
 *   So every query here casts dates to text in SQL (`col::text`) and this helper
 *   returns strings. Never add a query that selects a bare date column.
 *
 * Owner: Anh Tran (QC).
 */

/** Journal statuses the extract deliberately ignores — see `ebs_extract_journal_data`. */
export const IGNORED_JOURNAL_STATUSES = ['CANCELLED', 'PENDING_APPROVAL', 'PENDING', 'SKIPPED'];

export interface PendingJournalDay {
  /** `YYYY-MM-DD`. The date to extract; pass `journalDateFor(this)` to the mutation. */
  revenueEndDate: string;
  rows: number;
  accounts: number;
  amount: number;
  /**
   * Of `rows`, how many are actually EXTRACTABLE — i.e. their bill unit was
   * invoiced. Only these can ever reach the accounting extract.
   */
  extractable: number;
  /** `rows - extractable`. Journals whose bill unit was never invoiced. */
  stranded: number;
}

/**
 * THE SELECTION RULE, measured rather than assumed — jasec-dev 2026-09-15.
 *
 * `ebsExtract(type: INVOICE)` does NOT take every journal sitting on the target
 * date. It takes only those whose BILL UNIT WAS INVOICED, which is correct: you
 * cannot post revenue for an invoice that does not exist.
 *
 * This was found the hard way. The first run of ts-06 extracted 2026 date
 * 2028-08-09, which held 59 pending journal rows, and consumed 2 of them. That
 * looked like a broken extract. It is not:
 *
 *     consumed      2 rows   1 bill unit    invoiced = true
 *     left behind  57 rows  17 bill units   invoiced = false
 *
 * and all 17 un-invoiced bill units carry the -17.40 CVG ENERGIA credit line —
 * the 0-30 kWh true-up bill units that INVOICE_CHECK refuses (the known JASEC
 * fixed-charge defect). So their revenue is stranded upstream of accounting and
 * can never be extracted. That is a REPORTING consequence of a billing defect,
 * not an accounting defect, and the two must not be confused.
 *
 * Any assertion of the form "the whole day was consumed" is therefore wrong.
 * Scope it to the invoiced subset — that is what these two predicates are for.
 */
export const INVOICED_BILL_UNIT_SQL = `
  EXISTS (SELECT 1 FROM core_engine.invoice_unit iu WHERE iu.billunitid = rj.billunitid)`;

/**
 * A bill unit whose cycle is still OPEN.
 *
 * CORRECTION, 2026-09-15 — this qualifier was missing from the first version of
 * the stranded-revenue report and made it overstate the problem by 3x.
 *
 * A PENDING bill unit is the CURRENT cycle: it has not been closed, so of course
 * it has no invoice and of course its journals have not been extracted. That is
 * normal operation, not stranded revenue. Counting them produced "318 bill units
 * of revenue that can never reach the ERP" when the real figure is 100:
 *
 *     318 un-invoiced bill units
 *    -222 PENDING, i.e. simply still open
 *     100 CLOSED and never invoiced   <- the actual finding
 *
 * Only a CLOSED bill unit with no invoice is genuinely stuck.
 */
/**
 * THE REAL SELECTION PREDICATE, read from the database function rather than
 * inferred — `core_revenue.ebs_extract_journal_data` in `baseline-3.1.8.sql`.
 *
 * For an INVOICE extract the row is chosen on the **INVOICE DATE of its bill
 * unit**, NOT on the journal's own `revenueenddate`:
 *
 *     CASE WHEN revenueactivitytype IN ('PURCHASE','CANCEL','BILLING','MANUAL','USAGE')
 *          THEN ... EXISTS (SELECT 1 FROM core_engine.invoice_unit
 *                            WHERE billunitid = journal.billunitid
 *                              AND invoicedate = in_revenuedate::DATE)
 *          ELSE revenueenddate = in_revenuedate::DATE   -- AR daily extract only
 *     END
 *
 * and it also skips anything already extracted:
 *
 *     AND NOT EXISTS (SELECT id FROM core_revenue.accounting_entry
 *                      WHERE journalid = journal.id)    -- EP-5644
 *
 * WHY THIS MATTERS. We targeted 2026-12-31 on preprod because journal 1763 has
 * `revenueenddate = 2026-12-31`, and got "No data found". Its bill unit 146 IS
 * invoiced — as invoice 000091, dated **2027-01-09**. So the extract was right
 * and the target was wrong. That is also why the 36 rows that DID post are all
 * dated 2027-01-09: that is an invoice date, not a revenue date.
 *
 * Grouping candidate days by `revenueenddate` therefore proposes dates that can
 * never extract. Use INVOICE dates.
 */
export const NOT_ALREADY_EXTRACTED_SQL = `
  NOT EXISTS (SELECT 1 FROM core_revenue.accounting_entry ae WHERE ae.journalid = rj.id)`;

/**
 * Top-up journals never reach the ERP, so they are not "extractable".
 *
 * Measured on jasec-dev 2026-09-25 across every journal that has an
 * accounting_entry row:
 *
 *     revenueactivitytype   status    rows
 *     USAGE / BILLING       POSTED    3213     <- 100% post
 *     PURCHASE (top-up)     BILLED      22     <- never post
 *     PURCHASE (top-up)     POSTED       1
 *
 * Every non-posting journal on the tenant is a top-up
 * (`RECARGA SALDO ELECTRICIDAD PREPAGO`, item I-100007), and every other
 * activity type posts. That is consistent with the accounting: a prepaid top-up
 * is a liability, not recognised revenue, so it has nothing to report.
 *
 * Counting them as extractable made TC-141 fail on a journal the extract was
 * never going to post - journal 5685 on 2026-09-24, which DID gain an
 * accounting_entry row and still stayed BILLED. The extract was right; the
 * expectation was wrong.
 *
 * The single POSTED top-up is left unexplained on purpose rather than tidied
 * away: if top-ups start posting, this exclusion is what needs revisiting.
 */
export const NOT_A_TOPUP_SQL = `
  rj.revenueactivitytype IS DISTINCT FROM 'PURCHASE'`;

export const OPEN_CYCLE_SQL = `
  EXISTS (SELECT 1 FROM core_engine.bill_unit bu
           WHERE bu.id = rj.billunitid AND bu.status = 'PENDING')`;

export interface JournalBatchSummary {
  status: string;
  revenueActivityType: string;
  rows: number;
  amount: number;
}

export class AccountingDbHelper {
  constructor(private db: DbHelper) {}

  /**
   * Days that still hold un-extracted journals, newest first.
   *
   * `extractbatchid IS NULL` is the real "not yet extracted" marker — status
   * alone is not enough, because a re-extract resets rows to RECORDED while
   * leaving history behind.
   *
   * Use this to CHOOSE a target date instead of guessing one: an extract run
   * against a day with nothing pending returns "No data found" and proves
   * nothing at all.
   */
  async pendingJournalDays(limit = 20): Promise<PendingJournalDay[]> {
    const rows = await this.db.query<any>(
      `SELECT rj.revenueenddate::text           AS revenue_end_date,
              count(*)::int                     AS rows,
              count(DISTINCT rj.accountid)::int AS accounts,
              round(sum(rj.amount)::numeric, 2)::float8 AS amount,
              count(*) FILTER (WHERE ${INVOICED_BILL_UNIT_SQL})::int AS extractable
         FROM core_revenue.revenue_journal rj
        WHERE rj.extractbatchid IS NULL
          AND rj.status <> ALL ($1::text[])
          AND rj.revenueenddate IS NOT NULL
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT $2`,
      [IGNORED_JOURNAL_STATUSES, limit],
    );
    return rows.map((r) => ({
      revenueEndDate: r.revenue_end_date,
      rows: r.rows,
      accounts: r.accounts,
      amount: Number(r.amount ?? 0),
      extractable: r.extractable,
      stranded: r.rows - r.extractable,
    }));
  }

  /**
   * Days that hold journals the extract can ACTUALLY take, newest first.
   *
   * Use this to pick a target for a run. `pendingJournalDays` includes days whose
   * every journal is stranded behind an un-invoiced bill unit — extracting one of
   * those returns "No data found" and proves nothing.
   */
  async extractableJournalDays(limit = 20): Promise<PendingJournalDay[]> {
    const rows = await this.db.query<any>(
      `SELECT iu.invoicedate::date::text        AS revenue_end_date,
              count(*)::int                     AS rows,
              count(DISTINCT rj.accountid)::int AS accounts,
              round(sum(rj.amount)::numeric, 2)::float8 AS amount,
              count(*)::int                     AS extractable
         FROM core_revenue.revenue_journal rj
         JOIN core_engine.invoice_unit iu ON iu.billunitid = rj.billunitid
        WHERE rj.extractbatchid IS NULL
          AND rj.status <> ALL ($1::text[])
          AND ${NOT_ALREADY_EXTRACTED_SQL}
          AND ${NOT_A_TOPUP_SQL}
          AND iu.invoicedate IS NOT NULL
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT $2`,
      [IGNORED_JOURNAL_STATUSES, limit],
    );
    return rows.map((r) => ({
      revenueEndDate: r.revenue_end_date,
      rows: r.rows,
      accounts: r.accounts,
      amount: Number(r.amount ?? 0),
      extractable: r.extractable,
      // Every row here is joined to an invoice dated on the group's date, so by
      // construction none of them is stranded.
      stranded: 0,
    }));
  }

  /**
   * Un-extracted journal rows on exactly this `revenueenddate`, split by whether
   * the extract can reach them.
   */
  async pendingOn(invoiceDate: string): Promise<{ total: number; extractable: number; stranded: number }> {
    const rows = await this.db.query<any>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM core_engine.invoice_unit iu
                 WHERE iu.billunitid = rj.billunitid AND iu.invoicedate::date = $2::date)
                AND ${NOT_ALREADY_EXTRACTED_SQL}
                AND ${NOT_A_TOPUP_SQL})::int AS extractable
         FROM core_revenue.revenue_journal rj
        WHERE rj.extractbatchid IS NULL
          AND rj.status <> ALL ($1::text[])
          AND (rj.revenueenddate = $2::date OR EXISTS (
                SELECT 1 FROM core_engine.invoice_unit iu
                 WHERE iu.billunitid = rj.billunitid AND iu.invoicedate::date = $2::date))`,
      [IGNORED_JOURNAL_STATUSES, invoiceDate],
    );
    const total = rows[0]?.total ?? 0;
    const extractable = rows[0]?.extractable ?? 0;
    return { total, extractable, stranded: total - extractable };
  }

  /**
   * Ids of the journals on `revenueEndDate` that the extract should take —
   * un-extracted AND sitting on an invoiced bill unit.
   */
  async extractableJournalIdsOn(invoiceDate: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT rj.id
         FROM core_revenue.revenue_journal rj
        WHERE rj.extractbatchid IS NULL
          AND rj.status <> ALL ($1::text[])
          AND ${NOT_ALREADY_EXTRACTED_SQL}
          AND ${NOT_A_TOPUP_SQL}
          AND EXISTS (SELECT 1 FROM core_engine.invoice_unit iu
                       WHERE iu.billunitid = rj.billunitid
                         AND iu.invoicedate::date = $2::date)`,
      [IGNORED_JOURNAL_STATUSES, invoiceDate],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Revenue that can never reach the ERP: journals whose bill unit was never
   * invoiced, grouped by bill unit.
   *
   * Not an accounting defect — it is the accounting-side VISIBILITY of a billing
   * one. On jasec-dev every such bill unit carries the -17.40 CVG ENERGIA credit
   * that INVOICE_CHECK refuses.
   */
  async strandedRevenue(limit = 20): Promise<Array<{ billUnitId: string; accountId: string; rows: number; amount: number }>> {
    const rows = await this.db.query<any>(
      `SELECT rj.billunitid, min(rj.accountid) AS accountid, count(*)::int AS rows,
              round(sum(rj.amount)::numeric, 2)::float8 AS amount
         FROM core_revenue.revenue_journal rj
        WHERE rj.extractbatchid IS NULL
          AND rj.status <> ALL ($1::text[])
          AND rj.billunitid IS NOT NULL
          AND NOT ${INVOICED_BILL_UNIT_SQL}
          AND NOT ${OPEN_CYCLE_SQL}
        GROUP BY rj.billunitid
        ORDER BY 4 DESC
        LIMIT $2`,
      [IGNORED_JOURNAL_STATUSES, limit],
    );
    return rows.map((r) => ({
      billUnitId: r.billunitid, accountId: r.accountid,
      rows: r.rows, amount: Number(r.amount ?? 0),
    }));
  }

  /** What a batch ended up carrying, grouped by status and activity type. */
  async journalsInBatch(batchId: string): Promise<JournalBatchSummary[]> {
    const rows = await this.db.query<any>(
      `SELECT status,
              revenueactivitytype,
              count(*)::int AS rows,
              round(sum(amount)::numeric, 2)::float8 AS amount
         FROM core_revenue.revenue_journal
        WHERE extractbatchid = $1
        GROUP BY 1, 2
        ORDER BY 3 DESC`,
      [batchId],
    );
    return rows.map((r) => ({
      status: r.status,
      revenueActivityType: r.revenueactivitytype,
      rows: r.rows,
      amount: Number(r.amount ?? 0),
    }));
  }

  /**
   * Journal rows in a batch that are NOT POSTED.
   *
   * The extract's contract is that everything it stamps with a batch id is also
   * marked POSTED. Any row here is a real defect: a journal claimed by a batch
   * but never posted is revenue that has been reported to the ERP and not
   * recorded as such on our side.
   */
  async unpostedInBatch(batchId: string): Promise<Array<{ id: string; status: string; amount: number }>> {
    const rows = await this.db.query<any>(
      `SELECT id, status, amount::float8 AS amount
         FROM core_revenue.revenue_journal
        WHERE extractbatchid = $1
          AND status <> 'POSTED'
        LIMIT 50`,
      [batchId],
    );
    return rows.map((r) => ({ id: r.id, status: r.status, amount: Number(r.amount ?? 0) }));
  }

  /**
   * The header row as the DATABASE holds it — including `filepath`, which
   * GraphQL masks to null while the batch is PENDING.
   *
   * This is the only way to prove the `batchFinancialExtract=true` branch
   * actually wrote a file.
   */
  async headerRaw(batchId: string): Promise<Array<{
    id: string; batchId: string; extractStatus: string; type: string; period: string;
    inputDate: string; accountingDate: string; filePath: string | null;
    externalRefId: string | null; count: number; currencyCode: string;
  }>> {
    const rows = await this.db.query<any>(
      `SELECT id, batchid, extractstatus, type, period,
              inputdate::text      AS inputdate,
              accountingdate::text AS accountingdate,
              filepath, externalrefid, count, currencycode
         FROM core_revenue.ebs_header_extract
        WHERE batchid = $1
        ORDER BY createddate DESC`,
      [batchId],
    );
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batchid,
      extractStatus: r.extractstatus,
      type: r.type,
      period: r.period,
      inputDate: r.inputdate,
      accountingDate: r.accountingdate,
      filePath: r.filepath,
      externalRefId: r.externalrefid,
      count: r.count,
      currencyCode: r.currencycode,
    }));
  }

  /** How many extract headers exist. Take before/after to prove one was created. */
  async headerCount(): Promise<number> {
    const rows = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM core_revenue.ebs_header_extract`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Detail rows that break double entry, across the WHOLE tenant.
   *
   * A tenant-wide sweep rather than a per-batch check on purpose: an unbalanced
   * GL line is a defect wherever it is, and the cheapest way to catch a
   * regression in the extract is to assert the whole population stays clean.
   * 71/71 rows were clean on jasec-dev 2026-09-15.
   */
  async unbalancedDetailRows(): Promise<Array<{ id: string; batchId: string; index: number; credit: number; debit: number }>> {
    const rows = await this.db.query<any>(
      `SELECT id, batchid, index, credit::float8 AS credit, debit::float8 AS debit
         FROM core_revenue.ebs_detail_extract
        WHERE round(credit::numeric, 2) <> round(debit::numeric, 2)
           OR glaccount IS NULL OR gloffset IS NULL
           OR glaccount = gloffset
        LIMIT 50`,
    );
    return rows.map((r) => ({
      id: r.id, batchId: r.batchid, index: r.index,
      credit: Number(r.credit ?? 0), debit: Number(r.debit ?? 0),
    }));
  }

  /**
   * Population-level counts for stranded revenue — CLOSED bill units only.
   *
   * Counts BILL UNITS and ROWS, deliberately not CRC: on jasec-dev the money
   * total is dominated by nine tariff-suite bill units (the 60,000 kWh BLK50K
   * cases) worth 26.5M CRC against -8.8M for everything else, so a CRC headline
   * would misrepresent the problem.
   *
   * `openCycles` is reported alongside so the distinction stays visible: those
   * are NOT a problem, and conflating them is exactly the mistake the first
   * version of this report made (318 claimed, 100 real).
   *
   * `withCvgCredit` counts how many stranded units carry the -17.40 CVG ENERGIA
   * line. Measured 2026-09-15: 85 of 100. That is a CORRELATION, not a cause —
   * 21 other CLOSED bill units carrying the same credit invoiced normally, and
   * `billing/ts-10` proves a freshly created one invoices today. So the credit
   * does not block invoicing; something else, or history, explains these.
   */
  /**
   * The stranded population, split the way the TEAM classifies it (confirmed
   * 2026-09-15 and verified here against jasec-dev). Three different things, and
   * only one of them is a defect:
   *
   *   PENDING bill unit          the account's OPEN cycle. No total yet, cannot
   *                              be invoiced until billing closes it, and its
   *                              journals are RECORDED not BILLED so they were
   *                              never extract-eligible. NORMAL. The bulk.
   *   CLOSED + the -17.40 CVG    the INVOICE_CHECK / V10_9 population. Fails with
   *                              "Bill total and invoice total not matched".
   *                              **Re-invoiceable now that V10_9 is on dev** —
   *                              the team re-invoiced three on 2026-09-10
   *                              (002793/4/5), each coming out at 1,943.40 with
   *                              CVG ENERGIA -17.40 on the invoice.
   *   CLOSED, no CVG credit      billing itself failed. See `billCheckErrors()`.
   *
   * Measured 2026-09-15: 222 open / 85 CVG / 15 other. (The 15 grew from ~10 as
   * this suite's own mutating cases created bill units.)
   */
  async strandedByClass(): Promise<Array<{
    status: string; type: string; hasCvgCredit: boolean; billUnits: number; avgTotal: number;
  }>> {
    const rows = await this.db.query<any>(
      `WITH s AS (
         SELECT DISTINCT rj.billunitid
           FROM core_revenue.revenue_journal rj
          WHERE rj.extractbatchid IS NULL
            AND rj.status <> ALL ($1::text[])
            AND rj.billunitid IS NOT NULL
            AND NOT ${INVOICED_BILL_UNIT_SQL})
       SELECT bu.status, bu.type,
              (EXISTS (SELECT 1 FROM core_engine.transaction_unit t
                        WHERE t.billunitid = bu.id
                          AND round(t.netamount::numeric, 2) = -17.40)) AS has_cvg_credit,
              count(*)::int AS bill_units,
              round(avg(bu.total)::numeric, 2)::float8 AS avg_total
         FROM s JOIN core_engine.bill_unit bu ON bu.id = s.billunitid
        GROUP BY 1, 2, 3
        ORDER BY 4 DESC`,
      [IGNORED_JOURNAL_STATUSES],
    );
    return rows.map((r) => ({
      status: r.status, type: r.type, hasCvgCredit: r.has_cvg_credit,
      billUnits: r.bill_units, avgTotal: Number(r.avg_total ?? 0),
    }));
  }

  /**
   * Why billing failed, tenant-wide, grouped by error class.
   *
   * The column is `reason`, not `errormessage`. Reported, never failed on: these
   * are billing defects surfaced from the accounting side.
   */
  async billCheckErrors(): Promise<Array<{ errorClass: string; jobType: string; count: number; accounts: number }>> {
    const rows = await this.db.query<any>(
      `SELECT CASE
                WHEN reason ILIKE '%Credit Limit%' THEN 'CREDIT_LIMIT_BREACH_AT_BILL_CHECK'
                WHEN reason ILIKE '%Bill total and invoice total not matched%' THEN 'BILL_VS_INVOICE_MISMATCH'
                WHEN reason ILIKE '%Cannot get property%' THEN 'INTERNAL_ERROR_NULL_OBJECT'
                ELSE left(reason, 55) END AS error_class,
              type AS job_type, count(*)::int AS n, count(DISTINCT accountid)::int AS accts
         FROM core_engine.jobs_error
        GROUP BY 1, 2
        ORDER BY 3 DESC
        LIMIT 12`,
    );
    return rows.map((r) => ({
      errorClass: r.error_class, jobType: r.job_type, count: r.n, accounts: r.accts,
    }));
  }

  async strandedTotals(): Promise<{
    billUnits: number; rows: number; withCvgCredit: number; openCycles: number;
  }> {
    const rows = await this.db.query<any>(
      `WITH candidates AS (
         SELECT rj.billunitid,
                count(*)::int AS n,
                bool_or(bu.status = 'PENDING') AS open_cycle
           FROM core_revenue.revenue_journal rj
           JOIN core_engine.bill_unit bu ON bu.id = rj.billunitid
          WHERE rj.extractbatchid IS NULL
            AND rj.status <> ALL ($1::text[])
            AND rj.billunitid IS NOT NULL
            AND NOT ${INVOICED_BILL_UNIT_SQL}
          GROUP BY rj.billunitid)
       SELECT count(*) FILTER (WHERE NOT open_cycle)::int AS bill_units,
              coalesce(sum(n) FILTER (WHERE NOT open_cycle), 0)::int AS rows,
              count(*) FILTER (WHERE open_cycle)::int AS open_cycles,
              count(*) FILTER (WHERE NOT open_cycle AND EXISTS (
                  SELECT 1 FROM core_revenue.revenue_journal x
                   WHERE x.billunitid = candidates.billunitid
                     AND round(x.amount::numeric, 2) = -17.40))::int AS with_cvg_credit
         FROM candidates`,
      [IGNORED_JOURNAL_STATUSES],
    );
    return {
      billUnits: rows[0]?.bill_units ?? 0,
      rows: rows[0]?.rows ?? 0,
      withCvgCredit: rows[0]?.with_cvg_credit ?? 0,
      openCycles: rows[0]?.open_cycles ?? 0,
    };
  }

  /** Is revenue tracking on? Without it no journal is written and nothing can extract. */
  async isRevenueTrackingOn(): Promise<boolean> {
    return this.db.isRevenueTrackingOn();
  }
}
