/**
 * Tags: @jasec @billing @invoice-format
 *
 * B5 + B6 — does the invoice DOCUMENT match the format approved in JEPYP-125?
 *
 * PREMISE CORRECTED 2026-09-08 — MOST OF THIS IS ALREADY IMPLEMENTED.
 *
 * This file was first written assuming JEPYP-266 ("Invoice Template Configuration
 * - Changes", still Backlog/To do) meant NONE of the JEPYP-125 format was built,
 * so every check was expected to fail. That was WRONG, and it would have raised a
 * false gap with the team. Verified against the deployed template
 * (s3://embrix-tenants/jasec-dev/template/invoice/jasec_invoice_v4.xsl) and a real
 * rendered PDF:
 *
 *   item 1 header   IMPLEMENTED - renders "Factura Electronica Servicios
 *                   electricos PREPAGO No. 002781". Note it is NOT the ticket's
 *                   literal "Factura POR servicios electricos PREPAGO: No." -
 *                   same information, different wording. The first version of
 *                   this test required "por" and false-failed on it.
 *   item 4 history  PARTLY - a "Consumo (kWh)" chart renders. Whether it spans
 *                   12 months is not provable from the text layer.
 *   item 5 recargas IMPLEMENTED, and CONDITIONAL. v4 renders the "Ultimas
 *                   Recargas" block ONLY when the cycle contains top-ups
 *                   (line 449, `xsl:if test="rechargeList"`); a cycle with none
 *                   renders a deliberately blank cell. An earlier version of
 *                   this file asserted the block must always appear and FAILED,
 *                   and that failure was nearly raised as a defect - see the
 *                   retraction on the item 5 case. Never verified with top-ups
 *                   present, which is the genuine remaining gap.
 *
 * So these checks are now REGRESSION GUARDS on implemented behaviour. There is no
 * open product question left in this file — the one that used to be here (item 5)
 * was retracted 2026-09-10 as my own assertion bug. JEPYP-266 SHIPPED 2026-09-10
 * as template v5, so nothing here is red by design any more. Every check stays SOFT
 * so one run reports the whole picture.
 *
 * WHAT JEPYP-125 ASKS FOR (the "Changes" section):
 *   1. Header: "Factura por servicios electricos PREPAGO: No. XXXXXX"
 *      (and a POSTPAGO variant)
 *   2. Remove certain labels
 *   3. Redistribute certain labels
 *   4. Add historical billing / consumption for the last 12 months
 *   5. Add a top-ups resume
 * Plus branding: JASEC logo with the (R) upper right, and the brand palette
 * (Azul 8,44,81 / Verde 146,192,32 / Celeste 28,154,214 / Gris 230,231,232).
 *
 * WHAT IS ASSERTED HERE, AND WHAT IS NOT
 *
 * Items 1, 4 and 5 are TEXT and are asserted. Items 2 and 3 are "remove" and
 * "redistribute" against screenshots in the ticket, with no machine-readable
 * list of which labels — they cannot be asserted from text without inventing the
 * list, so they are reported as a manual check rather than faked. Branding is
 * colour and image placement, which pdf text extraction cannot see at all; also
 * manual. Saying so explicitly is the point — a green run here must not be read
 * as "the format is approved".
 *
 * WHERE THE PDF COMES FROM
 *
 * NOT the database. `invoice_unit.filepath` and `invoicebase64pdf` do not carry
 * it (documented in ts-03). The invoice PDF is only available as the attachment
 * on the invoice notification email, which is the path ts-03 case 7.2/7.4 uses
 * and passes on a real 106 KB invoice. So this needs NOTIFY_IMAP_* and skips
 * cleanly without it.
 *
 * READ-ONLY. No clock move, no billing run, no job_schedule slot, no staging.
 * Runnable at any time.
 *
 * Tester: Anh Tran (QC)
 */
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { EmailHelper, ParsedEmail } from '../../../../helpers/email.helper';
import { describePdf, extractPdfText } from '../../../../helpers/pdf.helper';
import { BillingGqlHelper } from '../../../../helpers/billing-gql.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

/** How far back to look for an invoice email. */
const SINCE = new Date(process.env.BILLING_FORMAT_SINCE ?? '2026-08-01');

/** Which tenant this run is pointed at - invoice numbering is per tenant. */
const TENANT = (process.env.TEST_ENV ?? '').trim();

// ── text-layer normalisers (JEPYP-266) ───────────────────────────────────────
//
// A PDF text layer does not preserve the separators the template wrote. Matching
// "2550-6800" literally would false-fail on "2550 6800" or on a non-breaking
// hyphen, so numbers are compared with separators stripped and text is compared
// with accents stripped. Getting this wrong is how the first version of the
// item-1 header check false-failed — see the JEPYP-125 note above.

/** Accent- and case-insensitive form, whitespace collapsed. For prose. */
function loose(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .join(' ')
    .toLowerCase();
}

/**
 * Separator-free form. For phone numbers, account numbers and IBANs, whose
 * grouping the renderer may change.
 *
 * Letters and punctuation are KEPT, so a match still needs the digits to be
 * contiguous in the source — this is not a digits-only soup that could match
 * across unrelated fields.
 */
function compact(s: string): string {
  return s
    .replace(/[\s ]/g, '')
    .replace(/[-‐‑‒–—―−]/g, '');
}

/**
 * One shared fetch. Finding the email is the slow part (IMAP paging plus a PDF
 * parse), and every case below reads the same document, so fetch once.
 */
let pdfText: string | null = null;
let pdfName = '';
let fetchNote = '';

test.describe('Invoice document format vs JEPYP-125 and JEPYP-266 (both shipped)', () => {
  /**
   * DO NOT TOUCH THE CLOCK. This file reads a PDF out of the mailbox — it does
   * not bill, does not stage a balance and does not care what date the tenant
   * thinks it is. But importing `jasec-fixtures` opts you in to the
   * `jasecCcpBaseline` AUTO-fixture, which calls `setAndVerifyCcpTime()` before
   * EVERY test whether the spec needs it or not.
   *
   * That is not free, and it is not local. CCP is tenant-global, so a six-test
   * run here issues six clock writes against whatever tenant `.env` currently
   * points at. On 2026-09-10 that was jasec-preprod while a colleague's
   * regression was running on it, and this file reset their clock to the
   * baseline six times. `.env` is one file shared by every session in this
   * working tree, and `Copy-Item` preserves timestamps, so a switch underneath
   * you leaves no visible trace.
   *
   * `ccpBaseline: null` opts out of the auto-fixture entirely — the fixture
   * checks for null before it reads or writes anything, so this costs zero
   * GraphQL calls. A read-only spec should never be able to move a shared clock.
   *
   * `ts-08-topup-before-billing.spec.ts` is the other jasec-fixtures consumer in
   * this folder and it genuinely does need the clock, so it keeps the default.
   */
  test.use({ ccpBaseline: null });

  test.skip(
    !process.env.NOTIFY_IMAP_USER || !process.env.NOTIFY_IMAP_PASSWORD,
    'NOTIFY_IMAP_* not configured — the invoice PDF is only available as an email attachment.',
  );

  test.beforeAll(async () => {
    const emailHelper = new EmailHelper();
    await emailHelper.connect();
    let emails: ParsedEmail[];
    try {
      emails = await emailHelper.searchEmails({
        match: (e) => /Factura|Estado de Cuenta/i.test(e.subject) && e.pdfAttachment() !== null,
        since: SINCE,
        // Was 3. Widened because the mailbox is SHARED between tenants and the
        // newest few invoices may all belong to the other one - see below.
        // Deeper when one invoice is targeted (JASEC_FORMAT_INVOICE): it is rarely in the newest 12.
        limit: (process.env.JASEC_FORMAT_INVOICE ?? '').trim() ? 150 : 12,
      });
    } finally {
      await emailHelper.disconnect();
    }

    if (!emails.length) {
      fetchNote = `no invoice email with a PDF attachment since ${SINCE.toISOString().slice(0, 10)}`;
      return;
    }

    /**
     * THE MAILBOX IS SHARED BETWEEN jasec-dev AND jasec-preprod.
     *
     * This used to take emails[0] - the newest matching mail - and assert on it
     * whatever tenant produced it. On 2026-09-14, with .env pointing at dev, it
     * read INVOICE_ACT-100054_000011_20260905.pdf, a PREPROD invoice billed
     * minutes earlier, and judged dev's expectations against a preprod document.
     * Nothing failed loudly; it simply tested the wrong environment.
     *
     * DISCRIMINATE ON THE INVOICE NUMBER, NOT THE ACCOUNT.
     *
     * A first version of this checked the account id from the filename and
     * accepted anything whose category was not UNKNOWN. That does not work:
     * both tenants number accounts from ACT-100000, so ACT-100054 exists on
     * BOTH, the check passed, and it still read the preprod document while
     * pointed at dev. Colliding identifiers make a presence test useless.
     *
     * The invoice number does not collide in practice - dev is into 002xxx
     * while preprod restarted at 0000xx after its rebuild - and more
     * importantly the pair must AGREE: the invoice must exist here AND belong
     * to the account named in the filename. Checking the pair is what makes
     * this correct rather than merely lucky about numbering.
     */
    const gql = new BillingGqlHelper();
    let chosen: ParsedEmail | null = null;
    const rejected: string[] = [];
    for (const e of emails) {
      const name = e.pdfAttachment()!.filename;
      /**
       * ACCEPT ANY ACCOUNT PREFIX, AND FAIL CLOSED WHEN THE NAME WILL NOT PARSE.
       *
       * This regex was `INVOICE_(ACT-\d+)_(\d{6})_` and the no-match branch was
       * `chosen = e; break;` — i.e. an unparseable filename was accepted with NO
       * tenant check at all. Not every account is `ACT-nnnnnn`: accounts created
       * through the CRM gateway are `AC-nnnnnn`, which never matched, so every
       * one of them walked straight past the guard.
       *
       * Caught 2026-09-16 while checking dev/preprod parity: a run pointed at
       * jasec-dev selected INVOICE_AC-648856_000108_20270209.pdf and asserted
       * against it. That invoice exists ONLY on preprod (0 rows on dev) — the
       * exact cross-tenant read this block was written to prevent, reintroduced
       * through the fallback.
       *
       * A guard that cannot identify its input must reject it. Accepting the
       * unknown is how all three of this suite's fail-open bugs worked.
       */
      const m = /INVOICE_([A-Z]+-\d+)_(\d{6})_/.exec(name);
      if (!m) {
        rejected.push(`${name} (filename does not parse - cannot prove it belongs to this tenant)`);
        continue;
      }
      const [, acct, invNo] = m;
      // Optional: aim at ONE invoice (TC-140 needs the one whose cycle had top-ups,
      // which is rarely the newest). Unset = newest invoice of this tenant, as before.
      const want = (process.env.JASEC_FORMAT_INVOICE ?? '').trim();
      if (want && invNo !== want) continue;
      const doc = await gql.getInvoice(invNo).catch(() => null);
      if (doc && String(doc.accountId ?? '') === acct) { chosen = e; break; }
      rejected.push(
        `${name} (invoice ${invNo}` +
        (doc ? ` belongs to ${doc.accountId} here, not ${acct}` : ' not on this tenant') + ')',
      );
    }

    if (!chosen) {
      fetchNote =
        `none of the ${emails.length} most recent invoice emails belong to this tenant - ` +
        `the mailbox is shared with the other environment. Skipped: ${rejected.join('; ')}`;
      return;
    }
    if (rejected.length) {
      console.log(`\n[B5/B6] skipped ${rejected.length} invoice(s) from the other tenant\n`);
    }

    const pdf = chosen.pdfAttachment()!;
    pdfName = pdf.filename;
    const summary = describePdf(pdf.content);
    if (!summary.valid) {
      fetchNote = `${pdf.filename} is not a complete PDF: ${summary.verdict}`;
      return;
    }
    pdfText = await extractPdfText(pdf.content);
    console.log(`\n[B5/B6] reading ${pdfName} (${summary.verdict})`);
  });

  /**
   * Report the whole file once, with the reason, rather than N confusing failures.
   *
   * "No invoice PDF for THIS tenant has reached the mailbox" is an unmet
   * PRECONDITION, not a defect — the document does not exist to be judged, so
   * nothing was proven either way. It used to FAIL, which puts a red line in the
   * report that the team would reasonably read as "the invoice is wrong".
   *
   * This became reachable on 2026-09-16: before the cross-tenant guard was fixed
   * this spec was silently reading PREPROD documents on a dev run and reporting
   * five green assertions, so the state never arose. Honest BLOCKED beats
   * dishonest green, but it must be labelled as BLOCKED.
   */
  test('an invoice PDF is available to assert on @jasec @billing @invoice-format', async () => {
    blockedIf(
      pdfText === null,
      fetchNote || 'no PDF text could be extracted from the chosen invoice email.',
    );
  });

  test('JEPYP-125 item 1 — header names the service and the modality @jasec @billing @invoice-format', async () => {
    test.skip(pdfText === null, fetchNote);
    // Approved wording: "Factura por servicios electricos PREPAGO: No. XXXXXX".
    // Accent- and case-tolerant, and tolerant of the number's format, because the
    // requirement is the WORDING and the modality, not the numbering scheme.
    // CORRECTED 2026-09-08 after reading a real PDF. The requirement text in
    // JEPYP-125 reads "Factura por servicios electricos PREPAGO: No. XXXXXX" but
    // the IMPLEMENTED wording is "Factura Electronica Servicios electricos PREPAGO
    // No. 002781" - same information, no "por", no colon. Requiring "por" made
    // this FALSE-FAIL on an invoice that satisfies the requirement. Match the
    // parts that carry meaning instead.
    const hasPhrase = /factura[^.]{0,30}servicios\s+el[eé]ctricos/i.test(pdfText!);
    const hasModality = /\bPREPAGO\b/i.test(pdfText!);
    expect
      .soft(
        hasPhrase,
        `${pdfName}: JEPYP-125 item 1 — no "Factura por servicios electricos" header. ` +
        `Implemented by JEPYP-266 (shipped 2026-09-10 as template v5).`,
      )
      .toBe(true);
    expect
      .soft(
        hasModality,
        `${pdfName}: JEPYP-125 item 1 — header does not state the PREPAGO modality. ` +
        `Implemented by JEPYP-266 (shipped 2026-09-10 as template v5).`,
      )
      .toBe(true);
  });

  test('JEPYP-125 item 4 — a 12-month billing / consumption history is present @jasec @billing @invoice-format', async () => {
    test.skip(pdfText === null, fetchNote);
    // WHAT ACTUALLY RENDERS is a chart headed "Consumo (kWh)" (template v4
    // line 397, paired side-by-side with the Recargas block at line 382). Assert
    // THAT, because it is the implemented shape.
    //
    // The 12-MONTH SPAN is deliberately NOT asserted: the chart is plotted
    // graphically and its month labels do not reliably reach the PDF text layer,
    // so a text search cannot tell a 12-month chart from a 3-month one. Claiming
    // otherwise would be a test that passes or fails for the wrong reason.
    // Verifying the span stays a MANUAL check - see the manual test below.
    // Whitespace-insensitive without a regex, so PDF text-layer spacing cannot
    // break it: collapse runs of whitespace, lowercase, then substring-match.
    const flat = pdfText!.split(/\s+/).join(' ').toLowerCase();
    const hasChart = flat.includes('consumo (kwh)') || flat.includes('consumo(kwh)');
    expect
      .soft(
        hasChart,
        `${pdfName}: JEPYP-125 item 4 - no "Consumo (kWh)" consumption section. ` +
        `This IS implemented in template v4, so a failure here is a REGRESSION, ` +
        `not pending work.`,
      )
      .toBe(true);
  });

  test('JEPYP-125 item 5 - the Ultimas Recargas block, when the cycle had top-ups @jasec @billing @invoice-format', async () => {
    test.skip(pdfText === null, fetchNote);

    // RETRACTED 2026-09-10 - THIS WAS MY BUG, NOT THE PRODUCT'S.
    //
    // This case used to FAIL and was written up as "the block is SUPPRESSED, not
    // empty - ask the team why". That was wrong and was nearly raised as a
    // defect. I had grepped the template for STRINGS and found both
    // "Ultimas Recargas" and "Sin recargas en este periodo", and a nearby comment
    // saying "an empty list still contributes one row" - then concluded something
    // must always render. I never read the `xsl:if` wrapping them.
    //
    // What template v4 actually does:
    //
    //   448  <xsl:if test="not(rechargeList)"><fo:block/></xsl:if>   <- no top-ups: EMPTY BLOCK
    //   449  <xsl:if test="rechargeList">                            <- everything below is INSIDE
    //   450      <fo:block ...>Ultimas Recargas</fo:block>
    //   451      <fo:table ...>  for-each rechargeList -> one row per top-up
    //   473          <xsl:if test="not(rechargeList)">               <- unreachable
    //   476              <fo:block>Sin recargas en este periodo</fo:block>
    //
    // So a cycle with NO top-ups renders a deliberately blank cell: no heading,
    // no table, no empty-state text. "Sin recargas en este periodo" is dead code
    // - nested inside `test="rechargeList"` yet guarded by `not(rechargeList)`.
    // Harmless belt-and-braces against an empty `fo:table-body`, not a bug.
    //
    // And invoice 002781 (ACT-100831) had **0 top-ups in its cycle**
    // (2026-07-15 .. 2026-09-11; one top-up on the account, outside the period).
    // The template was right; the assertion was wrong.
    //
    // WHY THIS CANNOT SELF-GATE. Knowing whether the account topped up in the
    // period needs `core_engine.subscription_topup`, and this project
    // (`jasec-billing-read`) has NO DATABASE and NO VPN on purpose. So the block's
    // absence cannot be told apart from "correctly blank" here. Rather than
    // guess, skip with the reason printed - unmet precondition, not a failure.
    //
    // THE REAL GAP THIS LEAVES: nobody has ever verified the summary renders when
    // top-ups DO exist, which is what JEPYP-47 actually requires ("a summary of
    // all top-ups completed during the billing period"). That needs
    // `ts-08-topup-before-billing.spec.ts` chained ahead of a billing run, then this
    // document re-read.
    //
    // NOT blocked on the sub-30 defects, contrary to an earlier note here. Those
    // only affect cycles with a sub-30 DEFICIT - the only path that produces the
    // negative CVG true-up line INVOICE_CHECK refuses. A non-sub-30 band bills and
    // invoices cleanly today: 002759 (35 kWh), 002756 (105), 002760 (220), 002761
    // (1000) all have cvg_trueup = 0 and produced invoices. So seed a ~105 kWh
    // cycle, top it up, bill it, and this case can be exercised now.
    const flat = pdfText!.replace(/\s+/g, ' ');
    const hasBlock = /ultimas\s+recargas/i.test(flat);
    const hasEmptyState = /sin\s+recargas/i.test(flat);

    // The reason is built ONCE and printed BEFORE the skip. Playwright's `line`
    // reporter does not print skip reasons, so relying on test.skip()'s message
    // alone leaves a silent "1 skipped" and the next person re-derives all of
    // this - or worse, re-raises it as a defect. Print it, then skip with it.
    const blockedReason =
      `${pdfName} has no "Ultimas Recargas" heading. Template v4 renders that block ONLY ` +
      `when the cycle contains top-ups (line 449, xsl:if test="rechargeList"), so a blank ` +
      `cell is CORRECT for a cycle with none - this is an unmet precondition, NOT a defect. ` +
      `To exercise it properly: run ts-08-topup-before-billing.spec.ts to place a real top-up ` +
      `inside the cycle, bill the cycle, then re-read the invoice.`;

    console.log(
      `\n[B5/B6] item 5 - Ultimas Recargas heading: ${hasBlock ? 'PRESENT' : 'absent'}` +
      `, empty state: ${hasEmptyState ? 'PRESENT' : 'absent'}` +
      `${hasBlock ? '' : `\n   BLOCKED (not failed): ${blockedReason}`}\n`,
    );

    test.skip(!hasBlock, `BLOCKED, not failed: ${blockedReason}`);

    // From here the block IS present, so the cycle had top-ups and the table must
    // be complete - a heading with no table underneath would be worse than no
    // heading at all.
    for (const header of ['Fecha', 'Cantidad', 'Forma de Pago']) {
      expect
        .soft(
          new RegExp(header.replace(/ /g, String.raw`\s+`), 'i').test(flat),
          `${pdfName}: the "Ultimas Recargas" block renders but its "${header}" column ` +
          `header is missing - the top-up table is incomplete.`,
        )
        .toBe(true);
    }

    // The dead empty-state row should never appear alongside real top-ups. If it
    // does, the outer condition has been changed and this case needs revisiting.
    expect
      .soft(
        hasEmptyState,
        `${pdfName}: "Sin recargas en este periodo" renders even though the ` +
        `"Ultimas Recargas" table is present. In v4 that string is unreachable, so ` +
        `the template's conditions have changed - re-read lines 448-476 before ` +
        `trusting this case.`,
      )
      .toBe(false);
  });

  /**
   * JEPYP-266 "Invoice Template Configuration - Changes" — the six contact and
   * bank-detail changes, asserted on the RENDERED invoice.
   *
   * JEPYP-266 SHIPPED 2026-09-10 as template v5. This case no longer expects to
   * fail: all six items are present in the deployed XSL (verified against S3 on
   * 2026-09-11, with the three old values confirmed gone). It is now a REGRESSION
   * GUARD. It currently SKIPS rather than runs, because the only readable PDF
   * predates v5 - see the gate at the top of the test body.
   *
   * SCOPE, settled with the team 2026-09-10 — do not widen it without re-asking:
   *   - Item 6 is an **ADD**, not a replace. The old single IBAN the ticket says
   *     to "replace" is not in this template at all; it only exists in the
   *     INACTIVE `jasec_prepaid_invoice_v1.xsl`. Luis: "yes need to add a table
   *     with 3 bank account information". Target confirmed as this invoice.
   *   - Item 4's line ("8511 0273 (Asistente virtual)") is likewise NOT in this
   *     template — it lives in the account-statement template. It is asserted
   *     ABSENT here anyway, cheaply, because the contact-strip edit is exactly
   *     the change that could copy the CoopeGuanacaste block across.
   *   - The account statement is out of scope entirely (Tri Do, 2026-09-10), so
   *     nothing here asserts anything about it.
   *
   * WHY ASSERT THE PDF AND NOT THE XSL. The template is not the deliverable and
   * the two genuinely disagree: v4 contains an "Ultimas Recargas" block that
   * never reaches the rendered document (see item 5 above). Only the PDF proves
   * what a customer receives.
   *
   * NOT ASSERTED: the WhatsApp *label*. The ticket says "add new line for
   * Whatsapp", but the tenant ships `Jasec_Prepaid_Icono_Whatsapp.png`, so the
   * label may render as an icon that text extraction cannot see. The NUMBER is
   * asserted; the word is only reported. Requiring a ticket's literal wording is
   * what false-failed item 1 the first time round.
   */
  test('JEPYP-266 — contact details and bank accounts on the invoice @jasec @billing @invoice-format', async () => {
    test.skip(pdfText === null, fetchNote);

    /**
     * THE DOCUMENT MUST BE A v5 RENDER, or this case cannot judge JEPYP-266.
     *
     * JEPYP-266 shipped 2026-09-10 as template v5 (confirmed: `template_files`
     * index 4 -> jasec_invoice_v5.xsl ACTIVE, and all six items verified present
     * in the deployed XSL). But the team's note is explicit: "Invoices issued
     * before today keep their old PDF unless they are regenerated."
     *
     * This spec reads the newest invoice PDF out of the MAILBOX, and the newest
     * readable document is 002781, rendered with v4. Asserting JEPYP-266 against it
     * fails for the wrong reason and re-reports a FIXED defect.
     *
     * An earlier version of this note said the cause was "SMTP down since
     * 2026-09-08". That was true when written and is NOT true now - preprod has
     * 0 failed sends and delivered on 2026-09-14. A dated environmental claim
     * baked into a message outlives the condition and then actively misleads:
     * it sends the reader to chase a mail server that is working. State the
     * blocker as what the gate below actually tests - the invoice NUMBER - and
     * leave the current cause to be read off the environment.
     *
     * Gate on the invoice NUMBER rather than on the contact values themselves.
     * Skipping "because the old values are present" would be circular - it would
     * also silently swallow a genuine reversion of v5. The number is independent:
     * 002793 was the first invoice rendered with v5.
     */
    /**
     * 2793 IS A jasec-dev INVOICE NUMBER. preprod restarts its numbering at
     * 000001, so every preprod invoice is below it and this case skipped on
     * every preprod run - reported as BLOCKED "no invoice >= 2793 has reached
     * the mailbox", which reads as an environment problem when it is a
     * hardcoded dev constant. Observed 2026-09-16: invoice 000102, rendered
     * THAT DAY under preprod's live v5 template, was excused as "predates
     * 2793". Same class of fault as BILLING_FIX_CUTOFF in Block I.
     *
     * So make it per tenant, and let a run override it. preprod's own boundary
     * is whatever its first v5 render was; it was rebuilt 2026-09-09 and v5
     * landed 2026-09-10, so a handful of early invoices may still be v4 -
     * override with JASEC_FIRST_V5_INVOICE when chasing one of those.
     */
    const FIRST_V5_INVOICE = Number(
      process.env.JASEC_FIRST_V5_INVOICE ??
      // dev only (2026-09-30): every other tenant started on v5.
      (TENANT === 'jasec-dev' ? '2793' : '1'),
    );
    const numMatch = /_(\d{6})_/.exec(pdfName);
    const invoiceNo = numMatch ? Number(numMatch[1]) : null;
    const staleReason =
      `${pdfName} is invoice ${invoiceNo ?? '(unparsed)'}, which predates ${FIRST_V5_INVOICE} - ` +
      `the first render with template v5, where JEPYP-266 landed. Older invoices keep ` +
      `their original PDF, so this document CANNOT show the new contacts and a failure ` +
      `here would mean nothing. No invoice numbered ${FIRST_V5_INVOICE} or higher has ` +
      `reached the mailbox yet, and the mailbox is the only route to a rendered PDF ` +
      `(invoice_unit.filepath and invoicebase64pdf are both null). ` +
      `Re-run once a new invoice has been issued and delivered. ` +
      `DO NOT re-report JEPYP-266 as unimplemented - the deployed v5 template carries ` +
      `all six items; verified against S3 on 2026-09-11.`;
    if (invoiceNo !== null && invoiceNo < FIRST_V5_INVOICE) {
      console.log(`\n[JEPYP-266] BLOCKED (not failed): ${staleReason}\n`);
    }
    test.skip(invoiceNo !== null && invoiceNo < FIRST_V5_INVOICE, `BLOCKED: ${staleReason}`);

    const text = loose(pdfText!);
    const tight = compact(pdfText!);

    // ── item 1 — legal name under the logo ────────────────────────────
    // Accent-insensitive on purpose: the template renders "Electrico" without
    // the accent the ticket uses ("Eléctrico"). Same name, and failing on a
    // missing diacritic would be reporting a typo as a missing feature. The
    // accent is raised separately as a wording question.
    expect
      .soft(
        text.includes('junta administrativa del servicio electrico municipal de cartago'),
        `${pdfName}: JEPYP-266 item 1 — the legal name "Junta Administrativa del ` +
        `Servicio Electrico Municipal de Cartago" is not on the document. This one ` +
        `ALREADY passed on 2026-09-09, so a failure here is a REGRESSION.`,
      )
      .toBe(true);

    // ── item 2 — customer-service email ───────────────────────────────
    expect
      .soft(
        text.includes('atencionalcliente@jasec.go.cr'),
        `${pdfName}: JEPYP-266 item 2 — "atencionalcliente@jasec.go.cr" is not on ` +
        `the document. Pending JEPYP-266.`,
      )
      .toBe(true);
    expect
      .soft(
        text.includes('facturacion@jasec.go.cr'),
        `${pdfName}: JEPYP-266 item 2 — the OLD address "facturacion@jasec.go.cr" is ` +
        `still on the document and must be removed. NOTE: the same address is also ` +
        `the issuer email in the stamping XML, which comes from emisor config and ` +
        `NOT from this template — fixing the template alone leaves the document sent ` +
        `to Hacienda wrong.`,
      )
      .toBe(false);

    // ── item 3 — main phone number ────────────────────────────────────
    // Exact numbers, not a \d{4}-\d{4} pattern: the text layer also carries
    // "00210038" and "79781664" from the fiscal identifiers, which such a
    // pattern would happily match.
    expect
      .soft(
        tight.includes('25506800'),
        `${pdfName}: JEPYP-266 item 3 — phone 2550-6800 is not on the document. ` +
        `Pending JEPYP-266.`,
      )
      .toBe(true);
    expect
      .soft(
        tight.includes('88285021'),
        `${pdfName}: JEPYP-266 item 3 — the OLD phone 8828-5021 is still on the ` +
        `document and must be removed.`,
      )
      .toBe(false);

    // ── item 4 — the Asistente virtual line must not appear ───────────
    expect
      .soft(
        text.includes('asistente virtual') || tight.includes('85110273'),
        `${pdfName}: JEPYP-266 item 4 — "8511 0273 (Asistente virtual)" appears on ` +
        `the invoice. It was NOT here on 2026-09-09 (it lives in the account-statement ` +
        `template), so it has been copied in — most likely along with the ` +
        `CoopeGuanacaste contact block. Check the whole contact strip.`,
      )
      .toBe(false);

    // Same guard, one level wider: the statement template's contact block is
    // CoopeGuanacaste's. It must never reach a JASEC invoice.
    expect
      .soft(
        text.includes('coopeguanacaste') || text.includes('coopeg'),
        `${pdfName}: a CoopeGuanacaste string appears on a JASEC invoice. The ` +
        `account-statement template (jasec_consumption_statement_v1.xsl) still ` +
        `carries CoopeG's contacts; this invoice must not inherit them.`,
      )
      .toBe(false);

    // ── item 5 — WhatsApp number ──────────────────────────────────────
    expect
      .soft(
        tight.includes('85506800'),
        `${pdfName}: JEPYP-266 item 5 — the WhatsApp number 8550-6800 is not on the ` +
        `document. Pending JEPYP-266.`,
      )
      .toBe(true);

    // ── item 6 — the three bank accounts ──────────────────────────────
    // One assertion listing everything missing, rather than six near-identical
    // failures, so the report says "add these" in one line.
    const bankTokens: Array<[string, string]> = [
      ['BCR account', '275-3136-4'],
      ['BCR IBAN', 'CR63015201275000313646'],
      ['BNCR account', '100-01-075-000831-8'],
      ['BNCR IBAN', 'CR63015107510010008319'],
      ['BPDC account', '001-012-0000-0121015607'],
      ['BPDC IBAN', 'CR15016101001210156077'],
    ];
    const tightUpper = tight.toUpperCase();
    const missing = bankTokens.filter(([, v]) => !tightUpper.includes(compact(v).toUpperCase()));
    expect
      .soft(
        missing.map(([k]) => k).join(', '),
        `${pdfName}: JEPYP-266 item 6 — ${missing.length} of ${bankTokens.length} bank ` +
        `details are missing from the invoice: ` +
        `${missing.map(([k, v]) => `${k} ${v}`).join('; ')}. This is an ADD (confirmed ` +
        `2026-09-10), so the three accounts need a new 3-column table — there is no ` +
        `existing IBAN on this template to replace.`,
      )
      .toBe('');

    // The superseded single account must never appear.
    expect
      .soft(
        tightUpper.includes('CR56015100910010042434') || tight.includes('15100910010042434'),
        `${pdfName}: the superseded single bank account (Cuenta IBAN ` +
        `CR56015100910010042434 / Cuenta Cliente BNCR 15100910010042434) is on the ` +
        `invoice. It belongs to the INACTIVE template and must not be carried over.`,
      )
      .toBe(false);

    // ── reported, not asserted ────────────────────────────────────────
    console.log(
      `\n[JEPYP-266] ${pdfName}\n` +
      `   item 1 legal name      ${text.includes('junta administrativa del servicio electrico municipal de cartago') ? 'PRESENT' : 'MISSING'}\n` +
      `   item 2 new email       ${text.includes('atencionalcliente@jasec.go.cr') ? 'PRESENT' : 'MISSING'}` +
      `   (old still there: ${text.includes('facturacion@jasec.go.cr') ? 'YES' : 'no'})\n` +
      `   item 3 new phone       ${tight.includes('25506800') ? 'PRESENT' : 'MISSING'}` +
      `   (old still there: ${tight.includes('88285021') ? 'YES' : 'no'})\n` +
      `   item 4 asistente line  ${text.includes('asistente virtual') ? 'PRESENT (bad)' : 'absent (good)'}\n` +
      `   item 5 whatsapp number ${tight.includes('85506800') ? 'PRESENT' : 'MISSING'}` +
      `   (word "whatsapp" in text layer: ${text.includes('whatsapp') ? 'yes' : 'no — may be an icon'})\n` +
      `   item 6 bank details    ${bankTokens.length - missing.length}/${bankTokens.length} present\n`,
    );
    test.info().annotations.push({
      type: 'jepyp-266',
      description:
        `item1 legalName=${text.includes('junta administrativa del servicio electrico municipal de cartago')}; ` +
        `item2 newEmail=${text.includes('atencionalcliente@jasec.go.cr')} oldEmail=${text.includes('facturacion@jasec.go.cr')}; ` +
        `item3 newPhone=${tight.includes('25506800')} oldPhone=${tight.includes('88285021')}; ` +
        `item4 asistenteLine=${text.includes('asistente virtual')}; ` +
        `item5 whatsappNumber=${tight.includes('85506800')}; ` +
        `item6 bankDetails=${bankTokens.length - missing.length}/${bankTokens.length}`,
    });
  });

  /**
   * Items 2, 3 and branding, reported not asserted.
   *
   * This test cannot fail. That is intentional: it exists so a run of this file
   * prints what is STILL a manual check, and so nobody reads a green result as
   * "the invoice matches the approved format".
   */
  test('JEPYP-125 items 2, 3 and branding remain MANUAL @jasec @billing @invoice-format', async () => {
    test.skip(pdfText === null, fetchNote);
    console.log(
      '\n[B5/B6] STILL MANUAL — not assertable from PDF text:\n' +
      '   item 2  remove labels        — the ticket shows screenshots, not a list of which\n' +
      '   item 3  redistribute labels  — layout, same reason\n' +
      '   branding                     — logo placement, the (R) mark, and the brand\n' +
      '                                  palette (Azul 8,44,81 / Verde 146,192,32 /\n' +
      '                                  Celeste 28,154,214 / Gris 230,231,232) are\n' +
      '                                  colour and image, which text extraction cannot see\n' +
      '   => a green run of this file does NOT mean the format is approved.\n',
    );
  });
});
