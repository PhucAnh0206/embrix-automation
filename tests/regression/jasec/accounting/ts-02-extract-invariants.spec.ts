/**
 * The accounting extract as a LEDGER — every batch on the tenant, swept.
 *
 * Point 10 of Huy's 2026-09-15 end-to-end guide: once billing has closed a cycle
 * and invoiced it, `ebsExtract` posts the journal entry that JASEC's Exactus ERP
 * consumes. This spec asserts that everything the extract has ever produced is a
 * well-formed double-entry ledger feed.
 *
 * READ-ONLY. No clock move, no extract run, no job_schedule slot, no account
 * state. No browser and NO VPN either — every fact here comes from
 * `searchEbsExtract` / `getEbsExtractDetailsById` over an ordinary Core UI
 * login, so it is safe at any time and from CI.
 *
 * WHY SWEEP THE POPULATION RATHER THAN CHECK ONE BATCH. An unbalanced GL line is
 * a defect wherever it sits, and a sweep is the cheapest regression net there
 * is: it catches a change in the extract against every batch the tenant has
 * accumulated, not just the one a test happened to create. Baseline on jasec-dev
 * 2026-09-15 — 18 headers, 71 detail rows, zero violations.
 *
 * Soft assertions throughout: one bad batch must not hide the other seventeen.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import { blockedIf } from '../../../../helpers/blocked.helper';
import {
  AccountingGqlHelper,
  extractInvariants,
  endOfMonth,
  type EbsHeader,
  type EbsDetail,
} from '../../../../helpers/accounting-gql.helper';

/** Cap the sweep so a tenant with years of batches still finishes quickly. */
const MAX_HEADERS = Number(process.env.JASEC_EBS_SWEEP_SIZE ?? 60);

let gql: AccountingGqlHelper;
let headers: EbsHeader[] = [];
const detailsOf = new Map<string, EbsDetail[]>();

test.describe('JASEC accounting — extract invariants', { tag: ['@jasec', '@accounting', '@tc-141'] }, () => {

  test.beforeAll(async () => {
    gql = new AccountingGqlHelper();
    headers = await gql.searchExtracts(1, MAX_HEADERS);
    for (const h of headers) {
      detailsOf.set(h.id, await gql.getDetails(h.id));
    }
    console.log(
      `\n  swept ${headers.length} extract header(s), ` +
      `${[...detailsOf.values()].reduce((a, d) => a + d.length, 0)} detail row(s)\n`,
    );
  });

  // ── the configuration that decides what the extract does ────────────────

  test('the ccp properties that govern the extract are readable and recorded', async () => {
    /**
     * These three decide the behaviour of everything below, so they are recorded
     * as evidence on every run rather than assumed:
     *
     *   useGLCombination      true  -> ebsExtract extracts journalDate MINUS ONE
     *                                DAY. This is the "pass the day after" rule
     *                                in the guide. Read it in the SQL function
     *                                core_revenue.ebs_extract_journal: when the
     *                                property is off, v_revenuedate is the date
     *                                you passed, unshifted.
     *   batchFinancialExtract true  -> the extract writes a CSV and posts nothing
     *                                to JASEC. false -> it posts to their
     *                                /centroContable endpoint for real.
     *   revenueTracking       true  -> journals are written at all. With it off
     *                                there is nothing to extract, ever.
     *
     * jasec-dev on 2026-09-15: all three true.
     */
    const useGl = await gql.ccpProperty('useGLCombination');
    const batchFile = await gql.ccpProperty('batchFinancialExtract');
    const revTracking = await gql.ccpProperty('revenueTracking');
    const offset = await gql.extractOffsetDays();

    console.log(
      `\n  useGLCombination=${useGl}  batchFinancialExtract=${batchFile}  ` +
      `revenueTracking=${revTracking}\n  => ebsExtract extracts journalDate minus ${offset} day(s)\n`,
    );

    // Revenue tracking off is an environment precondition, not a product defect:
    // no journal is ever written, so no extract can exist to assert on.
    blockedIf(
      String(revTracking).toLowerCase() !== 'true',
      `revenueTracking is "${revTracking}" on this tenant — no revenue journals are ` +
      `written, so the accounting extract has no source data. Team-owned config.`,
    );

    expect(useGl, 'useGLCombination must be set — the date offset depends on it').not.toBeNull();
    expect([0, 1]).toContain(offset);
  });

  // ── the ledger invariants ───────────────────────────────────────────────

  test('every extract batch is a balanced double-entry ledger', async () => {
    /**
     * The one rule that makes this feature correct or not. Checked three ways,
     * because each catches a different break:
     *
     *   header debit == header credit          a batch that does not balance
     *   each line's debit == its credit        one bad posting inside a good total
     *   header totals == sum of its own lines  a partially written batch
     *
     * Plus: every line must name two DIFFERENT GL accounts. A line posting to and
     * from the same account balances perfectly and moves nothing, so no totals
     * check can see it.
     */
    blockedIf(headers.length === 0, 'this tenant has no accounting extracts to assert on');

    const violations: string[] = [];
    for (const h of headers) {
      violations.push(...extractInvariants(h, detailsOf.get(h.id) ?? []));
    }

    if (violations.length) {
      console.log(`\n  ${violations.length} violation(s):\n` + violations.map((v) => `    - ${v}`).join('\n'));
    }
    expect
      .soft(violations, `accounting ledger violations across ${headers.length} batch(es)`)
      .toEqual([]);
  });

  test('every batch carries a currency, a type and at least one source record', async () => {
    for (const h of headers) {
      expect.soft(h.currencyCode, `batch ${h.batchId} has no currency`).toBeTruthy();
      expect.soft(h.type, `batch ${h.batchId} has no type`).toBeTruthy();
      /**
       * `count` is the number of SOURCE records swept in — invoices, not GL
       * lines. Batch 10017 reports 51 with 3 detail rows. Deliberately NOT
       * asserted equal to the detail-row count: that passes by coincidence on a
       * small batch and fails on every real one.
       */
      expect.soft(h.count, `batch ${h.batchId} claims ${h.count} source records`).toBeGreaterThan(0);
    }
  });

  // ── the period arithmetic ───────────────────────────────────────────────

  test('accountingDate is the last day of the month the batch posts into', async () => {
    /**
     * The extract stamps the batch into an accounting period: inputDate is the
     * day extracted, accountingDate is that month's close. Real header 2030 —
     * inputDate 2026-09-14, accountingDate 2026-09-30.
     *
     * This is the check that catches a month-end or leap-year slip, and it is
     * the assertion most likely to break silently in February.
     */
    for (const h of headers) {
      if (!h.inputDate || !h.accountingDate) continue;
      expect
        .soft(h.accountingDate, `batch ${h.batchId}: inputDate ${h.inputDate} should close at month end`)
        .toBe(endOfMonth(h.inputDate));
    }
  });

  test('period names the same month as inputDate', async () => {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (const h of headers) {
      if (!h.inputDate || !h.period) continue;
      const [y, m] = h.inputDate.split('-').map(Number);
      // Header renders `Sep-2026`; the DETAIL rows of the same batch render
      // `Sep-26`. Both are accepted here — the inconsistency is the product's,
      // and it is recorded in the accounting case notes rather than failed on.
      expect
        .soft(h.period, `batch ${h.batchId}: period vs inputDate ${h.inputDate}`)
        .toMatch(new RegExp(`^${MONTHS[m - 1]}-(${y}|${String(y).slice(2)})$`));
    }
  });

  // ── the two behaviours that look like bugs and are not ──────────────────

  test('filePath is masked while PENDING and present once SENT or RESENT', async () => {
    /**
     * `PGEbsExtractService.mapExtract` maps filePath as
     * `status == PENDING ? null : record.filepath`.
     *
     * So a PENDING batch reports no file over GraphQL even though the CSV was
     * written and the database column is populated — verified on batch 10018,
     * which reads null here and holds
     * `jasec-dev/data/journal/EBS_JOURNAL_EXTRACT_10018_15Sep2026_INVOICES.csv`
     * in the column. Proving a file WAS written needs the database (ts-03).
     *
     * This test pins the masking as intended behaviour so nobody raises it twice.
     */
    for (const h of headers) {
      if (h.extractStatus === 'PENDING') {
        expect
          .soft(h.filePath, `batch ${h.batchId} is PENDING, so GraphQL must mask filePath`)
          .toBeNull();
      }
      if (h.extractStatus === 'SENT' || h.extractStatus === 'RESENT') {
        expect
          .soft(h.filePath, `batch ${h.batchId} is ${h.extractStatus}, so filePath must be exposed`)
          .toBeTruthy();
      }
    }
  });

  test('a re-sent batch keeps its batchId, and only one header stays SENT', async () => {
    /**
     * `resendEbsExtract` does NOT create a new batch. It flips the existing
     * header to RESENT and writes a NEW header carrying the SAME batchId, count
     * and filePath, as SENT. Batch 10017 on jasec-dev is exactly this pair:
     * header 2025 RESENT, header 2029 SENT.
     *
     * Two consequences, both of which have bitten:
     *   - a batchId does not identify one header; match on `id`
     *   - the detail rows are duplicated per header, so summing detail across a
     *     batchId double-counts it
     */
    const byBatch = new Map<string, EbsHeader[]>();
    for (const h of headers) {
      byBatch.set(h.batchId, [...(byBatch.get(h.batchId) ?? []), h]);
    }

    let resendPairs = 0;
    for (const [batchId, group] of byBatch) {
      if (group.length < 2) continue;
      resendPairs++;

      const sent = group.filter((h) => h.extractStatus === 'SENT');
      expect
        .soft(sent.length, `batch ${batchId} has ${group.length} headers; at most one may be SENT`)
        .toBeLessThanOrEqual(1);

      // The superseded ones must say so, not sit there looking live.
      for (const h of group.filter((x) => x.extractStatus !== 'SENT')) {
        expect
          .soft(h.extractStatus, `batch ${batchId} header ${h.id} is superseded and must say so`)
          .toMatch(/^(RESENT|REGENERATED|PENDING|FAILED)$/);
      }

      // A resend re-sends the SAME numbers.
      const counts = new Set(group.map((h) => h.count));
      expect.soft(counts.size, `batch ${batchId}: headers disagree on source count`).toBe(1);
      const totals = new Set(group.map((h) => Math.round(h.totalDebitAmount * 100)));
      expect.soft(totals.size, `batch ${batchId}: headers disagree on total`).toBe(1);
    }

    console.log(`\n  ${resendPairs} batch(es) carry more than one header (resend history)\n`);
  });

  test('no batch is left FAILED', async () => {
    /**
     * FAILED is a real terminal state in the schema. A batch in it is revenue
     * that never reached the ERP, so it is reported as a finding rather than
     * tolerated — but as a soft check, since the sweep should still report
     * everything else.
     */
    const failed = headers.filter((h) => h.extractStatus === 'FAILED');
    if (failed.length) {
      console.log(`\n  FAILED batches: ${failed.map((h) => `${h.batchId} (header ${h.id})`).join(', ')}\n`);
    }
    expect.soft(failed.map((h) => h.batchId), 'batches in FAILED state').toEqual([]);
  });
});
