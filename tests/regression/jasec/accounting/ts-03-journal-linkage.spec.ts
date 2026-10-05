/**
 * What the extract CONSUMED — the journal side of point 10.
 *
 * ts-02 asserts that what the extract produced is a well-formed ledger. It
 * cannot see the other half: which `core_revenue.revenue_journal` rows were
 * swept up, that they moved to POSTED, and that they now carry the batch id.
 * That chain exists only in the database, so this spec needs the AWS VPN where
 * ts-01 and ts-02 deliberately do not.
 *
 * READ-ONLY. Queries only. No clock move — note this spec imports plain
 * `@playwright/test`, NOT the JASEC fixtures, because those carry an auto-fixture
 * that resets the tenant-global CCP clock before every test. A read-only spec
 * must not move a shared clock.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';
import { AccountingDbHelper } from '../../../../helpers/accounting-db.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

/**
 * Anomalies that already existed on jasec-dev before this suite was written,
 * found on 2026-09-15 by the first run of these very checks.
 *
 * **CONFIRMED BY THE TEAM 2026-09-15 as bring-up debris from the morning of
 * 2026-08-26**, when the extract chain was being made to work for the first time.
 * Neither has recurred. The assertions stay exactly as they are, so a NEW
 * occurrence still fails loudly — that was the team's explicit request too.
 *
 * Delete an entry only when the row itself is fixed; do not add one without a
 * written reason and a date.
 */
// Journal 1028 (batch 10002) was the one entry here. The team restored it to
// POSTED on 2026-09-29, so the entry was removed, as the rule above says.
const KNOWN_UNPOSTED_JOURNALS: string[] = [];

// Keyed by tenant: these are row ids, and the same id on another tenant is an
// unrelated row that must not be excused.
const KNOWN_BATCHES_WITHOUT_FILE: Record<string, string[]> = {
  'jasec-dev': [
    // Batch 10001, header 2001 — the FIRST extract ever run on this tenant
    // (2026-08-26 09:10:58), PENDING, count 2 with 4 detail rows, 4354.35. It is
    // the only header without a filepath; batch 10002, twelve minutes later, has
    // one. Same bring-up window, while the ledger accounts were being repaired and
    // the extract re-run. Confirmed as debris by the team 2026-09-15.
    '10001',
  ],
};

let db: DbHelper;
let acct: AccountingDbHelper;

test.describe('JASEC accounting — journal linkage', { tag: ['@jasec', '@accounting', '@tc-147'] }, () => {

  test.beforeAll(async () => {
    db = new DbHelper();
    await db.connect();
    acct = new AccountingDbHelper(db);
  });

  test.afterAll(async () => {
    await db?.disconnect();
  });

  test('revenue tracking is on, so journals exist to extract', async () => {
    const on = await acct.isRevenueTrackingOn();
    console.log(`\n  revenueTracking = ${on}\n`);
    blockedIf(
      !on,
      'revenueTracking is off on this tenant — no revenue journal rows are written, ' +
      'so the accounting extract has no source data. Team-owned config.',
    );
    expect(on).toBe(true);
  });

  test('every journal claimed by a batch is POSTED', async () => {
    /**
     * THE CONTRACT. `ebs_extract_journal_data` stamps `extractbatchid` and sets
     * `status = 'POSTED'` in the same statement. A row carrying a batch id but
     * not POSTED is revenue that has been reported to the ERP and not recorded
     * as reported on our side — the two systems disagree about what was sent.
     *
     * Swept across every batch rather than the newest, because the break is
     * silent and would otherwise only surface at a period close.
     */
    const batchIds = (await db.query<{ batchid: string }>(
      `SELECT DISTINCT extractbatchid AS batchid
         FROM core_revenue.revenue_journal
        WHERE extractbatchid IS NOT NULL`,
    )).map((r) => r.batchid);

    blockedIf(batchIds.length === 0, 'no journal has ever been extracted on this tenant');
    console.log(`\n  checking ${batchIds.length} batch(es) for unposted journals\n`);

    const offenders: string[] = [];
    for (const batchId of batchIds) {
      for (const row of await acct.unpostedInBatch(batchId)) {
        const known = KNOWN_UNPOSTED_JOURNALS.includes(row.id);
        const line = `batch ${batchId}: journal ${row.id} is ${row.status}, amount ${row.amount}`;
        if (known) {
          console.log(`  known pre-existing anomaly, see KNOWN_UNPOSTED_JOURNALS — ${line}`);
        } else {
          offenders.push(line);
        }
      }
    }

    expect
      .soft(offenders, 'journals stamped with a batch id but never POSTED')
      .toEqual([]);
  });

  test('the day-before rule is visible in the data the extract already produced', async () => {
    /**
     * THE STRONGEST EVIDENCE FOR THE OFFSET, and it costs nothing to check.
     *
     * `ebsExtract` is called with a journalDate and extracts the day BEFORE it
     * (when useGLCombination is true). The date actually extracted is stored as
     * `ebs_header_extract.inputdate`.
     *
     * CORRECTED 2026-09-29. The first version asserted
     *     header.inputdate == MAX(journal.revenueenddate in that batch)
     * which is the model disproved on 2026-09-16: an INVOICE extract selects a
     * journal on the INVOICE DATE of its bill unit, not on its revenueenddate
     * (`core_revenue.ebs_extract_journal_data`, baseline-3.1.8.sql; see
     * NOT_ALREADY_EXTRACTED_SQL in accounting-db.helper.ts). The old check only
     * held where the two dates coincided, and had to skip "stragglers-only"
     * batches — which were never stragglers, just rows whose revenue ended
     * before the invoice was cut.
     *
     * So this now replays the function's own date predicate against EVERY
     * journal each batch consumed:
     *
     *   activity PURCHASE/CANCEL/BILLING/MANUAL/USAGE  -> an invoice_unit of its
     *        bill unit is dated header.inputdate
     *     EXCEPT a top-up (transaction unit on the prepaid top-up offer) in an
     *        ACCOUNT_RECEIVABLE extract                 -> revenueenddate = inputdate
     *   anything else (AR daily extract)                -> revenueenddate = inputdate
     *
     * ALL rows, not MAX — with the right model there is no straggler exception.
     * Measured on jasec-dev 2026-09-29: 25 batches, 0 violations.
     *
     * Scope vs TC-145: this checks only WHICH DATE a consumed journal was taken
     * for. Whether it then reached POSTED — the half-extracted top-up finding —
     * is TC-145's assertion and the batch-status test above, not this one.
     *
     * DATES ARE CAST TO TEXT IN SQL. Read as a bare `date`, node-postgres hands
     * back a JS Date rendered in the local zone, which on this machine is one day
     * early — and this assertion is entirely about a one-day offset.
     */
    const rows = await db.query<any>(
      `WITH h AS (
         SELECT batchid,
                min(type)                          AS type,
                min(inputdate)::date               AS inputdate,
                count(DISTINCT inputdate::date)::int AS n_dates
           FROM core_revenue.ebs_header_extract
          GROUP BY batchid
       ), topup_tu AS (
         SELECT DISTINCT tu.id
           FROM core_engine.transaction_unit tu
           JOIN core_engine.transaction_balances tb ON tb.id = tu.id
          WHERE tb.offerid = (SELECT topupofferid FROM core_pricing.prepaid_system_offers LIMIT 1)
       ), j AS (
         SELECT h.batchid, h.type, h.inputdate, h.n_dates, rj.id,
                (rj.revenueactivitytype IN ('PURCHASE','CANCEL','BILLING','MANUAL','USAGE')
                 AND NOT (h.type = 'ACCOUNT_RECEIVABLE'
                          AND rj.transactionunitid IN (SELECT id FROM topup_tu))) AS by_invoice,
                rj.revenueenddate::date = h.inputdate AS end_ok,
                EXISTS (SELECT 1 FROM core_engine.invoice_unit iu
                         WHERE iu.billunitid = rj.billunitid
                           AND iu.invoicedate::date = h.inputdate) AS invoice_ok
           FROM h
           JOIN core_revenue.revenue_journal rj ON rj.extractbatchid = h.batchid
       )
       SELECT batchid,
              type,
              inputdate::text                                  AS header_inputdate,
              n_dates,
              count(*)::int                                    AS journal_rows,
              count(*) FILTER (WHERE by_invoice)::int          AS by_invoice_date,
              count(*) FILTER (WHERE NOT by_invoice)::int      AS by_revenue_end_date,
              count(*) FILTER (WHERE NOT CASE WHEN by_invoice THEN invoice_ok ELSE end_ok END)::int
                                                               AS violations,
              (array_agg(id::text ORDER BY id)
                 FILTER (WHERE NOT CASE WHEN by_invoice THEN invoice_ok ELSE end_ok END))[1:5]
                                                               AS sample_violations
         FROM j
        GROUP BY batchid, type, inputdate, n_dates
        ORDER BY batchid`,
    );

    blockedIf(rows.length === 0, 'no batch on this tenant has any journal linked to it');

    const total = rows.reduce((n, r) => n + r.journal_rows, 0);
    console.log(`\n  ${rows.length} batch(es), ${total} consumed journal(s) judged\n`);

    for (const r of rows) {
      if (r.n_dates > 1) {
        console.log(
          `  [note] batch ${r.batchid}: its headers carry ${r.n_dates} different inputdates; `
          + `judged against the earliest, ${r.header_inputdate}`,
        );
      }
      expect
        .soft(
          r.violations,
          `batch ${r.batchid} (${r.type}, inputdate ${r.header_inputdate}): ${r.violations} of ` +
          `${r.journal_rows} consumed journal(s) do not satisfy the extract's own date rule ` +
          `(${r.by_invoice_date} judged by invoice date, ${r.by_revenue_end_date} by revenueenddate). ` +
          `First offenders: ${(r.sample_violations ?? []).join(', ')}`,
        )
        .toBe(0);
    }
  });

  test('the file branch really wrote a file, even where GraphQL masks it', async () => {
    /**
     * `batchFinancialExtract = true` means the extract writes a CSV under
     * jasec-dev/data/journal/ and posts NOTHING to JASEC. ts-02 cannot confirm
     * the file: GraphQL maps filePath to null while the batch is PENDING, which
     * is most of them.
     *
     * The database column is the evidence. Checked here, and paired with the
     * masking assertion in ts-02, the two together prove the whole behaviour:
     * the file exists AND the API hides it until the batch is sent.
     */
    const flag = await db.query<{ value: string }>(
      `SELECT value FROM core_config.ccp_properties WHERE property = 'batchFinancialExtract'`,
    );
    const fileMode = (flag[0]?.value ?? '').trim().toLowerCase() === 'true';
    console.log(`\n  batchFinancialExtract = ${flag[0]?.value ?? '<unset>'} (file mode: ${fileMode})\n`);

    blockedIf(
      !fileMode,
      'batchFinancialExtract is false — this tenant posts to the JASEC gateway ' +
      'instead of writing a file, so there is no file to assert on.',
    );

    const rows = await db.query<any>(
      `SELECT id, batchid, extractstatus, filepath
         FROM core_revenue.ebs_header_extract
        ORDER BY createddate DESC`,
    );

    const missing: string[] = [];
    for (const r of rows) {
      if (r.filepath) {
        expect
          .soft(r.filepath, `batch ${r.batchid}: file must land under data/journal/`)
          .toMatch(/\/data\/journal\/EBS_JOURNAL_EXTRACT_/);
        continue;
      }
      if ((KNOWN_BATCHES_WITHOUT_FILE[process.env.TEST_ENV ?? ''] ?? []).includes(r.batchid)) {
        console.log(`  known pre-existing anomaly, see KNOWN_BATCHES_WITHOUT_FILE — batch ${r.batchid}`);
        continue;
      }
      missing.push(`batch ${r.batchid} (header ${r.id}, ${r.extractstatus}) has no filepath`);
    }

    expect.soft(missing, 'batches with no extract file recorded').toEqual([]);
  });

  test('no detail row anywhere on the tenant breaks double entry', async () => {
    /**
     * The same rule ts-02 applies through GraphQL, asserted straight against the
     * table. Deliberately duplicated: the GraphQL sweep is capped at a page of
     * headers, this is unbounded, and if the two ever disagree the API is
     * hiding rows — which is itself the finding.
     */
    const bad = await acct.unbalancedDetailRows();
    if (bad.length) {
      console.log('\n  ' + bad.map((b) => `batch ${b.batchId} line ${b.index}: credit ${b.credit} debit ${b.debit}`).join('\n  ') + '\n');
    }
    expect.soft(bad, 'detail rows that are unbalanced or missing a GL account').toEqual([]);
  });

  test('revenue stranded behind un-invoiced bill units is reported', async () => {
    /**
     * THE ACCOUNTING-SIDE VIEW OF A BILLING DEFECT. Not an extract fault.
     *
     * `ebsExtract(type: INVOICE)` can only post revenue for a bill unit that was
     * actually INVOICED. Any journal whose bill unit never produced an invoice is
     * therefore permanently unreachable: it will never appear in a batch, never
     * reach Exactus, and never show up as missing — it just sits there.
     *
     * Measured across the whole of jasec-dev, 2026-09-15, AFTER two corrections
     * that each changed the answer:
     *
     *     100 stranded bill units (CLOSED, never invoiced)
     *      85 of the 100 carry the -17.40 CVG ENERGIA credit
     *     222 further un-invoiced bill units are simply PENDING — open cycles,
     *         not a problem at all, and excluded
     *
     * CORRECTION 1. The first version counted every un-invoiced bill unit and
     * reported 318. Two thirds of those were open cycles that had not been closed
     * yet, so the figure was 3x too large.
     *
     * CORRECTION 2. It also blamed the 0-30 kWh true-up defect. The credit is a
     * CORRELATION, not a cause: 21 other CLOSED bill units carrying the same
     * -17.40 credit invoiced perfectly well, and `billing/ts-10` creates a fresh
     * sub-30 kWh cycle and watches it invoice today. So INVOICE_CHECK does not
     * refuse the credit — whatever stopped these 100 is either historical or
     * something else, and that is the open question for the team.
     *
     * COUNT BILL UNITS AND ROWS, NOT CRC. The money total is dominated by nine
     * tariff-suite bill units worth 26.5M CRC between them (the 60,000 kWh BLK50K
     * cases), against -8.8M for everything else. Quoting a CRC figure here would
     * mislead; the unit and row counts are the signal.
     *
     * Reported, not failed. Failing here would point the finger at accounting for
     * a break that lives upstream in billing. The counts should FALL as the
     * fixed-charge defect is fixed; a RISE is worth investigating.
     */
    const totals = await acct.strandedTotals();
    if (totals.billUnits === 0) {
      console.log('\n  no stranded revenue — every pending journal sits on an invoiced bill unit\n');
      return;
    }

    console.log(
      `\n  STRANDED REVENUE — ${totals.billUnits} CLOSED bill unit(s), ${totals.rows} journal row(s) ` +
      `that never invoiced and so can never reach the ERP.\n` +
      `  ${totals.openCycles} further un-invoiced bill unit(s) are PENDING, i.e. open cycles — ` +
      `EXCLUDED, they are normal.\n` +
      `  No CRC total is quoted: it is dominated by a handful of tariff-suite bill units.\n`,
    );

    console.log('  classification (team-agreed 2026-09-15):');
    for (const c of await acct.strandedByClass()) {
      const label = c.status === 'PENDING'
        ? 'open cycle — NORMAL'
        : c.hasCvgCredit
          ? 'V10_9 / INVOICE_CHECK — re-invoiceable'
          : 'billing itself failed — see the error table below';
      console.log(
        `    ${String(c.billUnits).padStart(4)}  ${c.status.padEnd(8)} ${c.type.padEnd(9)} ` +
        `cvg=${String(c.hasCvgCredit).padEnd(5)} avg ${String(c.avgTotal).padStart(10)}   ${label}`,
      );
    }

    /**
     * WHY billing failed, tenant-wide. Surfaced here because the accounting side
     * is where the consequence shows up, but every one of these is a BILLING
     * finding — raise them there, never against the extract.
     */
    console.log('\n  billing errors behind the closed-but-uninvoiced group:');
    for (const e of await acct.billCheckErrors()) {
      console.log(
        `    ${String(e.count).padStart(4)} occurrence(s) / ${String(e.accounts).padStart(3)} account(s)  ` +
        `${e.jobType.padEnd(20)} ${e.errorClass}`,
      );
    }

    console.log(
      '\n  The credit-limit class is the true-up charge at cycle close breaching the\n' +
      '  prepaid credit limit, with throwCreditLimitBreachException=true aborting the\n' +
      '  bill — the same mechanism as the rating-time breach (TC-57), on the billing\n' +
      '  path. Whether a customer with no credit at cycle close should still be billed\n' +
      '  the fixed charge is an open product question for Luis.\n',
    );
  });

  test('there is a pool of un-extracted journal days to run against', async () => {
    /**
     * Not an assertion about the product — a PRECONDITION REPORT for ts-06.
     *
     * The mutating spec needs a date that actually holds un-extracted journals;
     * run against an empty date the extract returns "No data found" and proves
     * nothing. This prints the candidates so ts-06 can be pointed at one, and
     * blocks rather than fails when the tenant has none left.
     */
    const days = await acct.pendingJournalDays(12);
    console.log('\n  un-extracted journal days (newest first):');
    console.log('    date          rows  extractable  stranded  accounts  amount');
    for (const d of days) {
      console.log(
        `    ${d.revenueEndDate}  ${String(d.rows).padStart(4)}  ` +
        `${String(d.extractable).padStart(11)}  ${String(d.stranded).padStart(8)}  ` +
        `${String(d.accounts).padStart(8)}  ${d.amount}`,
      );
    }

    const usable = days.filter((d) => d.extractable > 0);
    console.log(`\n  ${usable.length} of ${days.length} day(s) hold anything ts-06 could extract\n`);

    blockedIf(
      usable.length === 0,
      'no EXTRACTABLE revenue journals remain on this tenant — every pending journal ' +
      'sits on a bill unit that was never invoiced, so ts-06 has nothing to extract. ' +
      'Bill AND invoice an account first (billing ts-06).',
    );
    expect(usable.length).toBeGreaterThan(0);
  });

  /**
   * The SCHEDULED path — the one production will actually use, and the one
   * nothing in this block exercises.
   *
   * Every other case here drives `ebsExtract` by hand. In production it runs as
   * a job: `PGJobService` maps `JobType.EBS_EXTRACT` to the same mutation. That
   * needs TWO pieces of tenant config, and the interesting part is what happens
   * when only one of them is present.
   *
   *   a) `EBS_EXTRACT` in `core_config.config_job_list`, ordered AFTER
   *      BILL_CHECK and INVOICE_CHECK — the only hard ordering constraint.
   *   b) at least one row in `core_config.erp_extract_batches`.
   *
   * WHY (b) MATTERS, and why I had it wrong. I first recorded "empty is correct,
   * nothing reads that table". True of the MANUAL mutation, where the type comes
   * from `EbsExtractInput.type`. NOT true of the job: `insert_jobs` (V8_6_1,
   * the EBS_EXTRACT branch) builds the job payload FROM that table —
   *
   *     INSERT INTO core_engine.jobs
   *       SELECT ... '{"journalDate": "' || c_scheduledate || '", "type": "'
   *               || eeb.type || '"}' ... FROM core_config.erp_extract_batches eeb;
   *
   * — one job row per table row. With the table empty the scheduled job inserts
   * nothing and completes having done nothing at all: no error, no batch, no
   * warning. A job that looks configured, reports success every night, and never
   * posts a thing.
   *
   * SO THE ASSERTION IS A CONSISTENCY ONE, not "is it scheduled yet". An
   * unscheduled tenant is legitimate — dev need not run jobs at all — and failing
   * on that would be noise nobody reads. What is never legitimate is the
   * half-wired state, and that is what fails here.
   */
  // Tags come from the describe block — repeating them here duplicates them in the report.
  test('the scheduled extract path is either unwired or wired COMPLETELY, never half', async () => {
    const inJobList = await db.query<{ id: string; index: number }>(
      `SELECT id, index FROM core_config.config_job_list WHERE jobname = 'EBS_EXTRACT' ORDER BY id, index`,
    );
    const batchRows = await db.query<{ type: string }>(
      `SELECT type FROM core_config.erp_extract_batches`,
    );
    const everRan = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core_engine.jobs WHERE type = 'EBS_EXTRACT'`,
    );

    console.log(
      `\n  scheduled path: EBS_EXTRACT in config_job_list = ${inJobList.length} row(s), ` +
      `erp_extract_batches = ${batchRows.length} row(s), ` +
      `EBS_EXTRACT jobs ever run = ${everRan[0]?.n ?? 0}`,
    );

    if (inJobList.length === 0) {
      /**
       * Not wired at all. Legitimate on a tenant that does not schedule jobs, so
       * this reports rather than fails — but it is the state PRODUCTION must not
       * ship in, so it stays loud.
       */
      console.log(
        '  NOT SCHEDULED on this tenant — every extract here is a manual mutation.\n' +
        '  Production needs EBS_EXTRACT added to the tenant DAILY job list, ordered\n' +
        '  after BILL_CHECK and INVOICE_CHECK, AND at least one erp_extract_batches\n' +
        '  row (type INVOICE). Adding the job without the row gives a job that\n' +
        '  reports success nightly and posts nothing.',
      );
      return;
    }

    // Wired. Now it must be wired completely.
    expect(
      batchRows.length,
      `EBS_EXTRACT is in config_job_list but core_config.erp_extract_batches is EMPTY. ` +
      `insert_jobs builds the job payload FROM that table, so the scheduled extract ` +
      `will insert no job rows and complete having done nothing — silently, every night. ` +
      `Add at least one row (type INVOICE).`,
    ).toBeGreaterThan(0);

    console.log(`  batch types configured: ${batchRows.map((b) => b.type).join(', ')}`);

    /**
     * Ordering: the extract can only post revenue that billing and invoicing have
     * already produced, so it must sit after both in the same schedule.
     */
    for (const entry of inJobList) {
      const others = await db.query<{ jobname: string; index: number }>(
        `SELECT jobname, index FROM core_config.config_job_list
          WHERE id = $1 AND jobname IN ('BILL_CHECK', 'INVOICE_CHECK')`,
        [entry.id],
      );
      for (const o of others) {
        expect(
          entry.index,
          `in schedule ${entry.id}, EBS_EXTRACT runs at index ${entry.index} but ` +
          `${o.jobname} runs at ${o.index}. The extract can only post revenue that ` +
          `billing and invoicing already produced, so it must run AFTER both.`,
        ).toBeGreaterThan(o.index);
      }
    }
  });
});
