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
const KNOWN_UNPOSTED_JOURNALS = [
  // Journal 1028, batch 10002 (the tenant's only ACCOUNT_RECEIVABLE batch,
  // created 2026-08-26 09:22). -1000 CRC, revenueenddate 2026-08-05. Its sibling
  // row 1024 in the same batch DID post.
  //
  // CAUSE, from the team + verified here: the journal DOES have an accounting
  // entry (entry 13), but its `objectid` is "1028" — the journal id itself —
  // where sibling 1024's entry (entry 5) carries the invoice number "001785".
  // So the entry was written and the journal was stamped, but the step that
  // moves the row to POSTED keyed on something it could not match.
  //
  // MY EARLIER READING WAS WRONG and is corrected here: I guessed the cause was
  // a malformed `accountid`, because `031201` is not an `ACT-######` id. It is a
  // REAL account — verified ACTIVE / PREPAID / RESIDENTIAL — and JASEC's own
  // account numbers legitimately look like that. The id was never the problem.
  //
  // It is the only row in the whole database stamped with a batch and not POSTED.
  '1028',
];

const KNOWN_BATCHES_WITHOUT_FILE = [
  // Batch 10001, header 2001 — the FIRST extract ever run on this tenant
  // (2026-08-26 09:10:58), PENDING, count 2 with 4 detail rows, 4354.35. It is
  // the only header without a filepath; batch 10002, twelve minutes later, has
  // one. Same bring-up window, while the ledger accounts were being repaired and
  // the extract re-run. Confirmed as debris by the team 2026-09-15.
  '10001',
];

let db: DbHelper;
let acct: AccountingDbHelper;

test.describe('JASEC accounting — journal linkage', { tag: ['@jasec', '@accounting', '@tc-143'] }, () => {

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
     * `ebs_header_extract.inputdate`, and the journals swept up are the ones
     * whose `revenueenddate` is that date.
     *
     * So for every batch ever produced:
     *     header.inputdate == MAX(journal.revenueenddate in that batch)
     *
     * Verified true on 18 of 18 batches on jasec-dev, 2026-09-15.
     *
     * MAX, not ALL. A batch also sweeps up STRAGGLERS — older journals that were
     * never extracted, which `ebs_extract_journal_data` picks up via its
     * `NOT EXISTS (accounting_entry ...)` clause. Batch 10018 targeted
     * 2026-09-14 and legitimately carried USAGE rows back to 2026-07-15.
     * Asserting that every row matches the header date would fail on correct
     * behaviour.
     *
     * DATES ARE CAST TO TEXT IN SQL. Read as a bare `date`, node-postgres hands
     * back a JS Date rendered in the local zone, which on this machine is one day
     * early — and this assertion is entirely about a one-day offset.
     */
    const rows = await db.query<any>(
      `SELECT h.batchid,
              h.extractstatus,
              min(h.inputdate)::text      AS header_inputdate,
              max(j.revenueenddate)::text AS max_journal_end,
              min(j.revenueenddate)::text AS min_journal_end,
              count(j.*)::int             AS journal_rows,
              count(*) FILTER (
                WHERE j.revenueenddate::date = h.inputdate::date
              )::int                      AS rows_on_target_day
         FROM core_revenue.ebs_header_extract h
         JOIN core_revenue.revenue_journal   j ON j.extractbatchid = h.batchid
        GROUP BY h.batchid, h.extractstatus
        ORDER BY h.batchid`,
    );

    blockedIf(rows.length === 0, 'no batch on this tenant has any journal linked to it');

    /**
     * A BATCH THAT TOOK ONLY STRAGGLERS CANNOT SATISFY THIS RULE, AND THAT IS
     * CORRECT BEHAVIOUR.
     *
     * The rule reads MAX(revenueenddate) == inputdate. It holds when the target
     * day actually had journals. When the target day had NONE, the extract still
     * runs and still sweeps up stragglers — the older unextracted rows described
     * above — so MAX is the straggler date and the comparison fails against a
     * product doing exactly what it should.
     *
     * Measured on jasec-preprod 2026-09-22: batches 10003..10011 each carried
     * 3-7 journals, every one ending 2026-07-15, and ZERO rows on their own
     * inputdate (2026-08-23 .. 2026-09-20). All nine were reported as failures.
     * The 18/18 pass on jasec-dev came from dense daily journals, where every
     * batch had rows of its own — so this assertion had a dev-shaped assumption
     * baked into it.
     *
     * Batches with no row on their target day are therefore reported and skipped
     * rather than failed. Skipping silently would hide a tenant where NO batch
     * can be judged, so the count is printed and the case blocks if that is all
     * there is.
     */
    const judgeable = rows.filter((r) => r.rows_on_target_day > 0);
    const stragglersOnly = rows.filter((r) => r.rows_on_target_day === 0);

    console.log(
      `\n  ${rows.length} batch/status group(s): ${judgeable.length} judgeable, `
      + `${stragglersOnly.length} carried stragglers only\n`,
    );
    for (const r of stragglersOnly) {
      console.log(
        `  [skip] batch ${r.batchid}: no journal on its own inputdate `
        + `${r.header_inputdate}; ${r.journal_rows} straggler row(s) ending ${r.max_journal_end}`,
      );
    }

    blockedIf(
      judgeable.length === 0,
      `all ${rows.length} batch(es) on this tenant consumed stragglers only, so the `
      + 'day-before rule cannot be evidenced here. Extract a day that has journals of '
      + 'its own and re-run.',
    );

    for (const r of judgeable) {
      expect
        .soft(
          r.header_inputdate,
          `batch ${r.batchid} (${r.extractstatus}): the extract stamped inputdate ` +
          `${r.header_inputdate} but the newest journal it consumed ends ${r.max_journal_end} ` +
          `(${r.journal_rows} rows, ${r.rows_on_target_day} on the target day, ` +
          `oldest ${r.min_journal_end})`,
        )
        .toBe(r.max_journal_end);
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
      if (KNOWN_BATCHES_WITHOUT_FILE.includes(r.batchid)) {
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
