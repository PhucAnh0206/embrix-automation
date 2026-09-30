/**
 * Running the accounting extract for real — point 10 of the E2E guide, end to
 * end, as one scenario with named steps.
 *
 *     ebsExtract(journalDate: <target + offset>, type: INVOICE)
 *         -> a batch header with balanced double-entry detail lines
 *         -> the day's revenue journals move to POSTED, stamped with the batch
 *         -> a CSV under data/journal/, and nothing posted to JASEC
 *
 * ── MUTATING AND EFFECTIVELY IRREVERSIBLE ──────────────────────────────────
 *
 * `ebsExtract` CONSUMES the target day's revenue journals: it stamps them with a
 * batch id and flips them to POSTED. There is no un-extract. A day can only be
 * extracted once, so every run spends real test data.
 *
 * It is therefore gated twice over:
 *   - JASEC_EBS_RUN=true must be set, or the whole spec skips; and
 *   - it lives in the ts-06..ts-08 band, which is its own Playwright project
 *     (`jasec-accounting-run`) and is NOT part of any broad run.
 *
 * It does NOT move the CCP clock, spend a job_schedule slot, or bill anything —
 * so it is far cheaper than the billing mutating band, and it never touches
 * JASEC's systems while `batchFinancialExtract` is true.
 *
 *     $env:JASEC_EBS_RUN='true'
 *     npx playwright test --project=jasec-accounting-run
 *
 *     # or pin the day to extract (the date you want EXTRACTED, not the argument)
 *     $env:JASEC_EBS_DATE='2028-08-09'
 *
 * NEVER run this against jasec-preprod without agreeing it first: preprod feeds
 * real reconciliation data.
 *
 * Owner: Anh Tran (QC).
 */

import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';
import { AccountingDbHelper } from '../../../../helpers/accounting-db.helper';
import {
  AccountingGqlHelper,
  extractInvariants,
  endOfMonth,
  isNoDataFound,
  NO_DATA_FOUND,
  type EbsExtractResult,
} from '../../../../helpers/accounting-gql.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN_ENABLED = String(process.env.JASEC_EBS_RUN ?? '').trim().toLowerCase() === 'true';

/**
 * A SECOND, SEPARATE gate for TC-145. JASEC_EBS_RUN alone must never be enough to
 * reach a case that posts into a customer's live accounting system.
 */
const GATEWAY_RUN = String(process.env.JASEC_GATEWAY_RUN ?? '').trim().toLowerCase() === 'true';
/** The day to EXTRACT. The mutation argument is derived from it, never typed. */
const PINNED_DATE = (process.env.JASEC_EBS_DATE ?? '').trim();

let db: DbHelper;
let acct: AccountingDbHelper;
let gql: AccountingGqlHelper;

test.describe('JASEC accounting — extract run (MUTATING)', { tag: ['@jasec', '@accounting', '@tc-142'] }, () => {
  // 200+ journal rows in a batch; the mutation does real work.
  test.setTimeout(10 * 60 * 1000);

  test.beforeAll(async () => {
    db = new DbHelper();
    await db.connect();
    acct = new AccountingDbHelper(db);
    gql = new AccountingGqlHelper();
  });

  test.afterAll(async () => {
    await db?.disconnect();
  });

  test('extract a day of journals, and prove the whole chain', async () => {
    blockedIf(
      !RUN_ENABLED,
      'JASEC_EBS_RUN is not "true". This spec consumes a day of revenue journals ' +
      'irreversibly, so it never runs by accident. Set JASEC_EBS_RUN=true to run it.',
    );

    // ── step 1: the configuration that decides what happens ───────────────
    const offset = await gql.extractOffsetDays();
    const fileMode = await gql.isFlagOn('batchFinancialExtract');
    const ccp = await gql.ccpDate();
    console.log(
      `\n  ccp clock ${ccp} · extract offset ${offset} day(s) · ` +
      `${fileMode ? 'FILE mode (writes a CSV, posts nothing to JASEC)' : 'GATEWAY mode (POSTS TO JASEC)'}\n`,
    );

    /**
     * GATEWAY MODE IS THE PHASE 1 PATH — confirmed by the team 2026-09-15.
     *
     * File mode is the DEV safety setting: it writes a CSV to S3, leaves the
     * header PENDING and posts nothing, which is why 18 of 20 batches sit
     * PENDING. Only `sendExtractByGateway` ever marks a header SENT. No file
     * collector needs building for JASEC — that branch is generic platform
     * behaviour for tenants who take a file, and the EBS cron on the control
     * server belongs to MCM, a different tenant.
     *
     * So this gate is NOT "gateway is out of scope". It is "gateway posts to a
     * customer's live accounting system, and until Jeremy's change lands
     * (idOperacion taken from the batch id rather than the extract id) every send
     * creates a NEW idOperacion on their side, so a retry will not deduplicate".
     * That run is TC-145 and is done WITH the team, never incidentally.
     */
    blockedIf(
      !fileMode,
      'batchFinancialExtract is FALSE — this is GATEWAY mode, the Phase 1 delivery ' +
      'path. An extract would POST to JASEC\'s /centroContable and create a new ' +
      'idOperacion on their side that will NOT deduplicate on retry. Refusing to ' +
      'run incidentally: that is TC-145, run jointly with the team in an agreed ' +
      'window. See BLOCK-J_accounting-extract.md.',
    );

    // ── step 2: choose a day that actually holds journals ─────────────────
    // Running against an empty day returns "No data found" and proves nothing,
    // so the target is CHOSEN from the pending pool rather than guessed.
    /**
     * THE TARGET IS AN INVOICE DATE, NOT A REVENUE DATE.
     *
     * CORRECTED 2026-09-16, and this is what produced the long-standing
     * "No data found" open question. `ebsExtract(type: INVOICE)` selects a
     * journal on the INVOICE DATE of its bill unit — read from
     * `core_revenue.ebs_extract_journal_data`, not inferred:
     *
     *     EXISTS (SELECT 1 FROM core_engine.invoice_unit
     *              WHERE billunitid = journal.billunitid
     *                AND invoicedate = in_revenuedate::DATE)
     *
     * We were choosing the target by grouping on `revenueenddate`, so we asked
     * for 2026-12-31 (journal 1763's revenue date) when its invoice 000091 is
     * dated 2027-01-09. The extract was right; the target was wrong. It also
     * skips anything already in `accounting_entry` (EP-5644), which journal 1763
     * was — so it could never have extracted twice either.
     *
     * `JASEC_EBS_DATE`, if you pin one, is therefore an INVOICE date.
     */
    let target = PINNED_DATE;
    if (!target) {
      const days = await acct.extractableJournalDays(10);
      blockedIf(
        days.length === 0,
        'no EXTRACTABLE revenue journals remain on this tenant — every pending ' +
        'journal sits on a bill unit that was never invoiced. Bill and invoice an ' +
        'account first (billing ts-06), then re-run.',
      );
      target = days[0].revenueEndDate; // an INVOICE date - see the note above
      console.log(
        `  auto-selected target invoice date ${target} — ${days[0].extractable} ` +
        `extractable row(s), ${days[0].accounts} account(s)`,
      );
    }

    const before = await acct.pendingOn(target);
    console.log(
      `  ${target}: ${before.total} pending journal row(s) — ` +
      `${before.extractable} extractable, ${before.stranded} stranded on un-invoiced bill units`,
    );
    blockedIf(
      before.extractable === 0,
      `no EXTRACTABLE journals on ${target} (${before.stranded} are stranded behind ` +
      `un-invoiced bill units). Nothing to extract, so the run would prove nothing. ` +
      `Pick another JASEC_EBS_DATE.`,
    );

    const journalIdsBefore = await acct.extractableJournalIdsOn(target);
    const headersBefore = await acct.headerCount();
    const journalDate = await gql.journalDateFor(target);

    console.log(
      `\n  EXTRACTING ${target}  (${journalIdsBefore.length} extractable journal rows)\n` +
      `  calling ebsExtract(journalDate:"${journalDate}") — note the ${offset}-day offset\n`,
    );

    // ── step 3: run it ────────────────────────────────────────────────────
    const result: EbsExtractResult[] = await gql.ebsExtract(journalDate, 'INVOICE');
    const batch = result[0];

    /**
     * THE SILENT NO-OP. An empty extract answers HTTP 200 with
     * `{id:"0", batchId:"No data found"}`. Since step 2 proved journals were
     * pending on this date, that answer here means the extract did not pick them
     * up — a real defect, most likely in the date offset.
     */
    expect(
      isNoDataFound(batch),
      `ebsExtract returned "${NO_DATA_FOUND}" although ${journalIdsBefore.length} ` +
      `EXTRACTABLE journal row(s) were pending on ${target}. Either the ${offset}-day ` +
      `offset is wrong or the selection predicate rejected them.`,
    ).toBe(false);

    const batchId = batch.batchId!;
    console.log(`\n  -> batch ${batchId} (header ${batch.id})\n`);

    // ── step 4: the header is stamped with the day we meant to extract ────
    const raw = await acct.headerRaw(batchId);
    expect(raw.length, `no ebs_header_extract row was written for batch ${batchId}`).toBeGreaterThan(0);
    const header = raw[0];

    /**
     * THE OFFSET, PROVEN. We passed `journalDate` and asked for `target` to be
     * extracted. `inputdate` is the day the engine actually went and got. If the
     * offset is wrong, this is where it shows — and it is the one assertion the
     * whole guide's "pass the day after" instruction rests on.
     */
    expect(
      header.inputDate,
      `passed journalDate ${journalDate} expecting ${target} to be extracted ` +
      `(offset ${offset}), but the header records inputdate ${header.inputDate}`,
    ).toBe(target);

    expect(header.accountingDate, 'the batch must post into the target month\'s close')
      .toBe(endOfMonth(target));
    expect(await acct.headerCount(), 'exactly one new extract header').toBe(headersBefore + 1);

    // ── step 5: what it produced is a balanced ledger ─────────────────────
    const gqlHeaders = await gql.searchExtracts(1, 20, { batchId });
    const gqlHeader = gqlHeaders.find((h) => h.id === batch.id) ?? gqlHeaders[0];
    expect(gqlHeader, `batch ${batchId} is not visible through searchEbsExtract`).toBeTruthy();

    const details = await gql.getDetails(gqlHeader.id);
    console.log(
      `  header: ${gqlHeader.count} source record(s), ${details.length} GL line(s), ` +
      `debit ${gqlHeader.totalDebitAmount} / credit ${gqlHeader.totalCreditAmount}, ` +
      `status ${gqlHeader.extractStatus}\n`,
    );

    expect(details.length, `batch ${batchId} produced no GL detail lines`).toBeGreaterThan(0);
    expect(
      extractInvariants(gqlHeader, details),
      `batch ${batchId} is not a valid double-entry ledger`,
    ).toEqual([]);

    // ── step 6: what it consumed moved to POSTED ──────────────────────────
    /**
     * The other half of the contract, and the half GraphQL cannot show. Every
     * EXTRACTABLE journal on the target date must now be POSTED and carry this
     * batch id.
     *
     * Scoped to the extractable set on purpose. An earlier version asserted that
     * the WHOLE day was consumed and failed on correct behaviour: 57 of the 59
     * rows on 2028-08-09 sit on bill units INVOICE_CHECK refused, so no extract
     * can ever take them. See INVOICED_BILL_UNIT_SQL for the measurement.
     */
    /**
     * POLL, AND RE-FETCH INSIDE THE POLL. `ebsExtract` returns as soon as the
     * batch header exists; flipping the journals to POSTED and stamping them
     * happens after that. Reading once, immediately, catches them mid-flight.
     *
     * That is not hypothetical. On jasec-preprod 2026-09-22 this step reported
     * "extractable journals on 2027-01-09 that did not move to POSTED" and
     * "not stamped with batch 10015". Checked afterwards, all 36 journals on
     * that date were POSTED and carried batch 10015 — the assertion had simply
     * run too early, and a real product failure and a read-too-soon looked
     * identical in the report.
     *
     * The query is re-issued each round rather than the filter re-applied to a
     * stale result: retrying the check alone would spin on the same rows.
     */
    const settleDeadline = Date.now() + 120_000;
    let consumed: any[] = [];
    let notPosted: any[] = [];
    let notStamped: any[] = [];
    for (;;) {
      consumed = await db.query<any>(
        `SELECT id, status, extractbatchid
           FROM core_revenue.revenue_journal
          WHERE id = ANY($1::text[])`,
        [journalIdsBefore],
      );
      notPosted = consumed.filter((r) => r.status !== 'POSTED');
      notStamped = consumed.filter((r) => r.extractbatchid !== batchId);
      if (!notPosted.length && !notStamped.length) break;
      if (Date.now() >= settleDeadline) {
        console.log(
          `\n[extract] ${notPosted.length} not POSTED and ${notStamped.length} not stamped `
          + `after 120s — reporting as a real failure, not a read-too-soon.\n`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }

    expect
      .soft(
        notPosted.map((r) => `${r.id} is ${r.status}`),
        `extractable journals on ${target} that did not move to POSTED`,
      )
      .toEqual([]);
    expect
      .soft(
        notStamped.map((r) => `${r.id} -> batch ${r.extractbatchid ?? 'null'}`),
        `extractable journals on ${target} that were not stamped with batch ${batchId}`,
      )
      .toEqual([]);

    const after = await acct.pendingOn(target);
    expect(
      after.extractable,
      `${target} must have no EXTRACTABLE journals left (${after.stranded} stranded ` +
      `on un-invoiced bill units is expected and not counted here)`,
    ).toBe(0);
    expect
      .soft(await acct.unpostedInBatch(batchId), `batch ${batchId} contains a journal that is not POSTED`)
      .toEqual([]);

    const summary = await acct.journalsInBatch(batchId);
    console.log('  journals consumed:');
    for (const s of summary) {
      console.log(`    ${s.status.padEnd(9)} ${s.revenueActivityType.padEnd(10)} ${String(s.rows).padStart(4)} rows  ${s.amount}`);
    }
    console.log('');

    // ── step 7: the file branch wrote a file and posted nothing ───────────
    expect(header.filePath, `batch ${batchId}: batchFinancialExtract is true, so a CSV must be recorded`)
      .toMatch(/\/data\/journal\/EBS_JOURNAL_EXTRACT_/);
    expect(header.filePath, 'the file name carries the batch id').toContain(batchId);

    /**
     * In file mode nothing is sent to JASEC, so there must be no external
     * reference. A value here would mean the gateway was called after all —
     * which, per the guide, creates a new idOperacion on their side.
     */
    expect(header.externalRefId, `batch ${batchId} was posted to JASEC despite FILE mode`).toBeNull();

    // And GraphQL masks that path while the batch is PENDING — pinned here
    // against the database column, so the two views are proven together.
    if (gqlHeader.extractStatus === 'PENDING') {
      expect(
        gqlHeader.filePath,
        'GraphQL must mask filePath while PENDING even though the column is set',
      ).toBeNull();
    }

    // ── step 8: extracting the same day again does not double-post ────────
    /**
     * The day has just been emptied, so a second call should find nothing. The
     * assertion that MATTERS is the safety one: whatever it returns, the journals
     * already in this batch must not be re-stamped into another. A double post
     * would report the same revenue to the ERP twice.
     *
     * "No data found" is the expected answer and is checked softly — a straggler
     * sweep (`ebs_extract_journal_data` also picks up journals missing from
     * accounting_entry) can legitimately produce a second, DIFFERENT batch.
     */
    const again = await gql.ebsExtract(journalDate, 'INVOICE');
    console.log(`  re-run of ${journalDate} -> ${again.map((r) => r.batchId).join(', ') || '<nothing>'}\n`);

    expect
      .soft(isNoDataFound(again[0]), `re-extracting ${target} should find nothing left`)
      .toBe(true);

    const reStamped = await db.query<any>(
      `SELECT id, status, extractbatchid
         FROM core_revenue.revenue_journal
        WHERE id = ANY($1::text[]) AND extractbatchid <> $2`,
      [journalIdsBefore, batchId],
    );
    expect(
      reStamped.map((r) => `${r.id} moved to batch ${r.extractbatchid}`),
      `journals from batch ${batchId} were re-extracted into another batch — double posting`,
    ).toEqual([]);

    console.log(`  PASS — ${target} extracted once, as batch ${batchId}, and not again.\n`);
  });

  /**
   * TC-145 — GATEWAY MODE. EPDP-509. The Phase 1 delivery path.
   *
   * This is the only case in the suite that puts data into a CUSTOMER'S LIVE
   * ACCOUNTING SYSTEM. There is no JASEC test instance: dev, preprod and
   * production all carry the same
   *   BASE_URL http://138.94.59.18:8087 + SEND_ACCOUNTING_EXTRACT /centroContable
   * (team-verified 2026-09-15, character for character on both tenants). The only
   * thing keeping either environment quiet is the ccp property
   * `batchFinancialExtract`. So this runs ONLY in an agreed window, with JASEC
   * informed, behind its own separate gate.
   *
   * ── WHAT IT PROVES, AND WHY THE RESEND IS THE POINT ────────────────────────
   *
   * Delivery alone is already evidenced — batch 10017 was accepted twice. The
   * open defect is that it was accepted TWICE:
   *
   *   A-104593  idOperacion 2028  status OK  6 registros  duplicado FALSE
   *   A-104594  idOperacion 2029  status OK  6 registros  duplicado FALSE
   *
   * Same batch, two postings, and JASEC's duplicate protection did not fire on
   * the second because the idOperacion differed. `PGEbsExtractService:900` sets
   * `accountingExtract.id = extract.id` — the ebs_header_extract id — and a
   * resend creates a NEW header, so it carries a NEW id. Verified here: every
   * one of the six postings ever made sent `request.idOperacion` equal to its
   * own header id.
   *
   * There is NO config shortcut. `CanonicalAccountingExtractRequest.AccountingExtract`
   * carries only id, journalDate, extractDate, header, details, customAttributes —
   * no batchId — and gateway-common walks the canonical graph by dotted path, so
   * re-pointing the request map at a field that does not exist would contribute
   * nothing and look like a silent success. It needs an engine change and a
   * deploy.
   *
   * So the case posts once and then RESENDS THE SAME BATCH, and asserts two
   * things that only both hold once the fix is deployed:
   *
   *   1. the resend carries the SAME idOperacion as the first send
   *   2. JASEC answers `duplicado: true` to it
   *
   * Assertion 1 tells you the fix is in. Assertion 2 tells you their side
   * honoured it. Failing 1 with 2 absent is "not deployed"; passing 1 and
   * failing 2 is a genuine finding on their side.
   *
   * ── WHY THIS IS CHEAPER FOR JASEC, NOT MORE EXPENSIVE ──────────────────────
   * Run AFTER the fix: posting one is accepted, posting two is rejected as a
   * duplicate — ONE record for them to disregard. Run BEFORE the fix: both are
   * accepted as distinct operations — TWO to disregard, which is exactly how
   * batch 10017 ended up needing two.
   *
   *     $env:JASEC_EBS_RUN='true'; $env:JASEC_GATEWAY_RUN='true'
   *     npx playwright test --project=jasec-accounting-run
   *
   * Owner: Anh Tran (QC). Run jointly with the team.
   */
  test('TC-145 — gateway delivers the batch to JASEC, and a resend deduplicates', async () => {
    blockedIf(
      !RUN_ENABLED,
      'JASEC_EBS_RUN is not "true". This consumes a day of revenue journals irreversibly.',
    );
    blockedIf(
      !GATEWAY_RUN,
      'JASEC_GATEWAY_RUN is not "true". This case POSTS INTO JASEC\'S LIVE ACCOUNTING ' +
      'SYSTEM — there is no test endpoint, dev and preprod both point at ' +
      'http://138.94.59.18:8087/centroContable. It runs only in an agreed window with ' +
      'JASEC informed. A second, separate gate on purpose: JASEC_EBS_RUN alone must ' +
      'never be enough to reach it.',
    );

    const fileMode = await gql.isFlagOn('batchFinancialExtract');
    blockedIf(
      fileMode,
      'batchFinancialExtract is TRUE, so this tenant is in FILE mode and nothing would ' +
      'be posted. TC-145 needs the team to set it false for the window and back to true ' +
      'afterwards — we never flip it ourselves. See BLOCK-J_accounting-extract.md.',
    );

    const offset = await gql.extractOffsetDays();
    console.log(`\n  GATEWAY MODE — this POSTS to JASEC. offset ${offset} day(s)\n`);

    // ── step 1: a day that actually holds extractable journals ────────────
    const days = await acct.extractableJournalDays(12);
    blockedIf(
      days.length === 0,
      'no day holds extractable journals, so there is nothing to deliver. Bill and ' +
      'invoice an account first.',
    );
    const target = PINNED_DATE || days[0].revenueEndDate;
    const expectedRows = (await acct.pendingOn(target)).extractable;
    console.log(`  target ${target} — ${expectedRows} extractable journal row(s)`);

    // ── step 2: post it ───────────────────────────────────────────────────
    const result = await gql.ebsExtract(await gql.journalDateFor(target), 'INVOICE');
    expect(isNoDataFound(result[0]), `the extract found nothing on ${target}`).toBe(false);
    const batchId = result[0].batchId!;
    const headerId = result[0].id!;
    console.log(`  -> batch ${batchId} (header ${headerId})`);

    /**
     * The gateway call is synchronous inside the mutation, so by the time it
     * returns the activity row is written. Poll anyway — a slow reply should not
     * read as a missing row.
     */
    const activityFor = async (entityId: string) => {
      for (let i = 0; i < 12; i++) {
        const rows = await db.query<any>(
          `SELECT id, entityid,
                  request->>'idOperacion'          AS idoperacion,
                  response->>'status'              AS status,
                  response->>'duplicado'           AS duplicado,
                  response->>'registrosRecibidos'  AS registros,
                  response->>'errorCode'           AS errorcode,
                  canonicalresponse->>'referenceId' AS referenceid
             FROM core_engine.activity
            WHERE apiname = 'SEND_ACCOUNTING_EXTRACT' AND entityid = $1
            ORDER BY id DESC LIMIT 1`,
          [entityId],
        );
        if (rows.length) return rows[0];
        await new Promise((r) => setTimeout(r, 2_000));
      }
      return null;
    };

    const first = await activityFor(headerId);
    expect(first, `no SEND_ACCOUNTING_EXTRACT activity row for header ${headerId}`).not.toBeNull();
    console.log(
      `  posted: idOperacion ${first.idoperacion} · status ${first.status} · ` +
      `${first.registros} registros · duplicado ${first.duplicado}` +
      (first.errorcode ? ` · errorCode ${first.errorcode}` : ''),
    );

    expect(first.errorcode, `JASEC rejected the posting with errorCode ${first.errorcode}`).toBeFalsy();
    expect(first.status, 'JASEC did not answer status OK to the first posting').toBe('OK');
    expect(
      Number(first.registros),
      'JASEC reported a different number of records than we sent',
    ).toBeGreaterThan(0);
    expect(
      first.duplicado,
      'the FIRST posting of a new batch must not be a duplicate',
    ).toBe('false');

    // ── step 3: the header reached SENT, which only the gateway path does ──
    const sent = await acct.headerRaw(batchId);
    const sentHeader = sent.find((h: any) => String(h.id) === String(headerId)) ?? sent[0];
    expect(
      sentHeader.extractStatus,
      `gateway delivery must leave the header SENT, not ${sentHeader.extractStatus}. ` +
      `Only sendExtractByGateway ever sets SENT.`,
    ).toBe('SENT');
    expect(
      sentHeader.externalRefId,
      'a delivered batch must carry the gateway referenceId in externalRefId',
    ).toBeTruthy();
    console.log(`  header ${headerId}: ${sentHeader.extractStatus}, externalRefId ${sentHeader.externalRefId}`);

    /**
     * Stop BEFORE the resend when the first posting already shows the fix is
     * not deployed. Pre-fix, idOperacion is the extract HEADER id; post-fix it
     * comes from the batch. Resending pre-fix posts the same revenue to JASEC a
     * second time as an unrelated operation — the "TWO to disregard" outcome
     * above — and proves nothing assertion 1 could not already tell us here.
     * When the header id happens to equal the batch id the two cannot be told
     * apart, so that case goes ahead.
     */
    blockedIf(
      String(first.idoperacion) === String(headerId) && String(headerId) !== String(batchId),
      `the first posting sent idOperacion ${first.idoperacion} = its own header id, not ` +
      `batch ${batchId}, so the idOperacion engine change is NOT DEPLOYED. Not resending: ` +
      `that would post batch ${batchId} to JASEC a second time. ONE record (header ` +
      `${headerId}) for JASEC to disregard from this run.`,
    );

    // ── step 4: RESEND the same batch — the deduplication proof ───────────
    /**
     * `resendEbsExtract` flips the original header to RESENT and writes a NEW
     * header carrying the SAME batchId. Before the fix that new header's id
     * becomes the new idOperacion and JASEC sees an unrelated operation.
     */
    console.log('\n  resending the same batch — expecting JASEC to reject it as a duplicate');
    const resend = await gql.resendEbsExtract(headerId, batchId, false);
    expect(isNoDataFound(resend[0]), 'the resend produced nothing').toBe(false);
    const resendHeaderId = resend[0].id!;
    expect(
      resend[0].batchId,
      'a resend must keep the SAME batchId — a new batch id means it re-extracted, not resent',
    ).toBe(batchId);

    const second = await activityFor(resendHeaderId);
    expect(second, `no activity row for the resend (header ${resendHeaderId})`).not.toBeNull();
    console.log(
      `  resent: idOperacion ${second.idoperacion} · status ${second.status} · ` +
      `duplicado ${second.duplicado}`,
    );

    /**
     * THE ASSERTION THIS CASE EXISTS FOR.
     *
     * Two separate facts, asserted separately so the failure tells you which
     * side is at fault.
     */
    expect(
      second.idoperacion,
      `the resend sent idOperacion ${second.idoperacion} but the original sent ` +
      `${first.idoperacion}. They must MATCH — idOperacion has to come from the BATCH id, ` +
      `not the extract header id, or JASEC cannot recognise a retry. If these differ, ` +
      `the engine change is NOT DEPLOYED and this run has just posted the same revenue ` +
      `to JASEC twice as two unrelated operations. Tell them.`,
    ).toBe(first.idoperacion);

    expect(
      second.duplicado,
      `we sent the same idOperacion twice and JASEC still answered duplicado=${second.duplicado}. ` +
      `Our side is correct; their duplicate protection did not fire. This is a finding for JASEC.`,
    ).toBe('true');

    // ── step 5: and nothing was double-posted on our side ─────────────────
    const unposted = await acct.unpostedInBatch(batchId);
    expect(
      unposted.map((r: any) => `${r.id} is ${r.status}`),
      `batch ${batchId} has journals that are not POSTED after delivery`,
    ).toEqual([]);

    console.log(
      `\n  PASS — batch ${batchId} delivered to JASEC and the resend was deduplicated. ` +
      `ONE record for JASEC to disregard, not two.\n`,
    );
  });
});
