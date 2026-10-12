/**
 * TS-03 — Rendered notification content, replayed from the database.
 *
 * WHAT THIS IS FOR
 *
 * `core_engine.email_notification.content` stores the full rendered HTML body of
 * every notification the engine has ever produced, and it is written BEFORE the
 * SMTP send — so the body survives even when delivery fails. That gives us two
 * things the IMAP path cannot:
 *
 *   1. A REGRESSION GATE THAT DOES NOT FLAKE. SMTP on this tenant loses ~5% of
 *      sends at batchSizeBilling=60 (4.7% and 5.2% measured on two independent
 *      runs). Asserting content over IMAP would fail roughly a third of
 *      multi-account runs for reasons that have nothing to do with the
 *      templates. Reading content from the DB removes that entirely.
 *
 *   2. VERIFICATION WITH NO BILLING RUN. Every assertion here runs against
 *      notifications that ALREADY EXIST, so this spec needs no staging, no
 *      schedule slot, and no CCP move — none of the one-shot constraints that
 *      make the manual runbook expensive. It is safe to run any time.
 *
 * WHAT IT DOES NOT COVER
 *
 * Checks marked `contextual` in the templates need figures only a live staged
 * run can supply (X, C, the post-charge balance, the staged kWh band). They are
 * skipped here and asserted by the staged billing spec instead. Delivery itself,
 * recipient addressing and PDF attachments also need the live path — INVOICE_READY
 * rows carry a NULL `email` and sometimes a customer number rather than an
 * account id.
 *
 * Requires: VPN + DB_* env. No browser, no mailbox.
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { DbHelper } from '../../../../helpers/db.helper';
import { NotificationDbHelper } from '../../../../helpers/notification-db.helper';
import { NotificationReportHelper } from '../../../../helpers/notification-report.helper';
import { EmailHelper, type ParsedEmail } from '../../../../helpers/email.helper';
import { describePdf, extractPdfText, pdfField } from '../../../../helpers/pdf.helper';
import { BILLING_EVENT_TEMPLATES } from '../../../../test-data/notifications/billing-events.templates';
import { topUpConfirmationTemplate } from '../../../../test-data/notifications/topup-confirmation.template';
import type { NotificationContext, NotificationTemplate } from '../../../../test-data/notifications/types';
import { blockedIf } from '../../../../helpers/blocked.helper';

/** Every template this suite knows how to replay, keyed by notification type. */
const TEMPLATES: Record<string, NotificationTemplate> = {
  ...BILLING_EVENT_TEMPLATES,
  BALANCE_TOPUP: topUpConfirmationTemplate,
};

/**
 * Types with no rows yet, and why. Reported rather than failed — a missing row
 * here is a known defect being tracked elsewhere, not a broken test.
 */
const EXPECTED_MISSING: Record<string, string> = {
  CREDIT_LIMIT_BREACH:
    'JEPYP-230 §4.2 — the email is delivered but no email_notification row is ' +
    'ever written for this type. 13 Event 4 emails arrived on 2026-10-09 with ' +
    'zero rows logged. ROOT CAUSE CONFIRMED by dev (Tri Do, 2026-08-12): the send ' +
    'happens OUTSIDE the transaction, so when the code throws ' +
    'CREDIT_LIMIT_EXCEEDED everything except the email is rolled back — and an ' +
    'email cannot be unsent. Fix is to send only on a clean exit; a refactor of ' +
    'the email flow is acknowledged as needed. Not a template defect.',
};

/**
 * How many recent renderings per type to scan for consistency beyond the one
 * under assertion. 12 covers several billing runs without making the suite slow.
 */
const SCAN_DEPTH = 12;

// artifacts/, NOT test-results/ - Playwright WIPES test-results around runs
// (.gitignore:20 says so), so evidence written there can vanish between being
// produced and being read. Recommendation 6 of SUITE-AUDIT-2026-09-10; the same
// fault was already fixed for ts-02's run plan on 2026-09-10 and for the
// jasec-latest-meter.json handoff. Closed 2026-09-17.
const outDir = path.join(process.cwd(), 'artifacts', 'notification-reports');

let db: DbHelper;
let notifyDb: NotificationDbHelper;
let connectedDb = '(unknown)';
let totalRows = 0;
const report = new NotificationReportHelper();

test.beforeAll(async () => {
  db = new DbHelper();
  await db.connect();
  notifyDb = new NotificationDbHelper(db);

  // WHICH DATABASE AM I ON. `.env` is rewritten in place by switch-env.ps1, so
  // it is easy to point a dev-shaped run at preprod without noticing — an
  // earlier manual staging session did exactly that. An empty table on the wrong
  // host otherwise presents as "every template skipped", which reads like a
  // clean run. Record the target and the row count so it cannot be missed.
  const [{ db_name }] = await db.query<{ db_name: string }>('SELECT current_database() AS db_name');
  connectedDb = db_name;
  const [{ n }] = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM core_engine.email_notification',
  );
  totalRows = Number(n);
  console.log(`\n[TS-03] connected to ${connectedDb} — ${totalRows} email_notification rows\n`);
});

test.afterAll(async () => {
  await db?.disconnect();
});

test.describe('TS-03 — rendered notification content (replay)', () => {
  for (const [type, template] of Object.entries(TEMPLATES)) {
    test(`${type} — body renders per template`, async () => {
      let rows = await notifyDb.getNotifications({ type });

      // BALANCE_TOPUP: the seeding helpers (PrepaidSeedHelper.topUp) top up over the
      // subscriptionTopUp API with no payment source and no reference, so their
      // confirmation mail has a blank "ID Transacción" by construction. Since the
      // 2026-10-08 provisioning runs those are the newest rows on dev, and judging
      // one reads as a template defect. Replay customer-channel top-ups only:
      // drop subscriptions whose top-ups are ALL source-less and reference-less. A
      // customer top-up that loses its reference still carries a payment source,
      // so it is still judged.
      if (type === 'BALANCE_TOPUP' && rows.length) {
        const seededOnly = new Set(
          (
            await db.query<{ s: string }>(
              `SELECT subscriptionid AS s FROM core_engine.subscription_topup
                GROUP BY subscriptionid
               HAVING bool_and(paymentsource IS NULL AND coalesce(paymentrefid, '') = '')`,
            )
          ).map((r) => r.s),
        );
        const customer = rows.filter((r) => !r.entityId || !seededOnly.has(r.entityId));
        const dropped = rows.length - customer.length;
        if (dropped) {
          test.info().annotations.push({
            type: 'seeded-topups-excluded',
            description: `${dropped} BALANCE_TOPUP row(s) from API-seeded subscriptions (no payment source, no reference) not replayed`,
          });
        }
        rows = customer;
      }

      if (!rows.length) {
        const reason = EXPECTED_MISSING[type];
        test.info().annotations.push({
          type: 'no-data',
          description:
            reason ??
            `No ${type} rows in email_notification on "${connectedDb}" ` +
            `(${totalRows} rows total) — nothing to replay.`,
        });
        // A type with a known logging defect must not fail the gate; an
        // unexpected absence should be visible but is still not a content
        // regression, so skip either way and let the annotation carry it.
        test.skip(true, reason ?? `No ${type} rows to replay`);
        return;
      }

      // Rows arrive ordered by id DESC — insertion order, NOT createddate, which
      // is CCP-stamped and therefore not chronological on this tenant. Prefer a
      // SUCCESS row so the SMTP-status check reflects template health rather than
      // a transport failure we already know about.
      const row = rows.find((r) => r.status === 'SUCCESS') ?? rows[0];
      const subject = (await notifyDb.getConfiguredSubject(type)) ?? '';
      const templateFile = await notifyDb.getTemplateFile(type);
      const email = notifyDb.toParsedEmail(row, subject);
      const who = await lookupName(row.accountId);

      const ctx: NotificationContext = {
        accountId: row.accountId,
        firstName: who.firstName,
        lastName: who.lastName,
        recipient: row.email ?? '(none recorded)',
        // createddate is stamped from the CCP clock, not wall time, so it is the
        // run date. The strict month-vs-run assertion is `contextual` and so does
        // not fire in replay — see monthMatchesRunCheck.
        ccpDate: toIsoDate(row.createdDate),
        email,
        // Body comes from email_notification.content, so delivery time is not
          // measured here. Undefined rather than 0, which would read as instant.
          deliverySeconds: undefined,
        notificationStatus: row.status,
        templateFile,
      };

      // Contextual checks need a live staged run — drop them here rather than
      // reporting false failures.
      const replayable: NotificationTemplate = {
        ...template,
        checks: template.checks.filter((c) => !c.contextual),
      };
      const skipped = template.checks.length - replayable.checks.length;

      const results = report.evaluateAll(replayable, ctx);

      test.info().annotations.push({
        type: 'replayed',
        description:
          `${type} | account ${row.accountId} | ${row.status} | ` +
          `${toIsoDate(row.createdDate)} | template ${templateFile ?? '(unknown)'} | ` +
          `${replayable.checks.length} checks, ${skipped} contextual skipped`,
      });

      for (const r of results) {
        if (r.knownDefect) {
          if (!r.passed) {
            test.info().annotations.push({
              type: 'known-defect',
              description: `${r.row}: ${r.knownDefect}`,
            });
          }
          continue;
        }
        expect
          .soft(r.passed, `${type} / ${r.row}\n  expected: ${r.expected}\n  actual:   ${r.actual}`)
          .toBe(true);
      }

      const markdown = report.buildJiraTable(replayable, ctx, results);
      const file = report.writeReport(replayable, ctx, markdown);
      await test.info().attach(`replay-${type}.md`, { path: file, contentType: 'text/markdown' });

      // ── Consistency scan over older renderings ────────────────────────
      //
      // Asserting only the newest row makes the verdict depend on which row
      // happens to be newest, and that silently hid a real finding: when the
      // ordering changed from createddate to id, ACT-100569's top-up (three
      // blank receipt fields) stopped being the row under test and the type
      // flipped from Fail to Pass with no template change.
      //
      // So scan the recent history too. Older rows are ANNOTATED, not failed —
      // legacy renderings from superseded template versions must not hold the
      // gate red forever — but nothing gets to disappear just because a newer
      // row looks fine.
      const scan = rows.slice(0, SCAN_DEPTH).filter((r) => r !== row);
      const anomalies: string[] = [];
      for (const other of scan) {
        const otherCtx: NotificationContext = {
          ...ctx,
          accountId: other.accountId,
          recipient: other.email ?? '(none recorded)',
          ccpDate: toIsoDate(other.createdDate),
          email: notifyDb.toParsedEmail(other, subject),
          notificationStatus: other.status,
        };
        const failed = report
          .evaluateAll(replayable, otherCtx)
          .filter((r) => !r.passed && !r.knownDefect)
          .map((r) => r.row);
        if (failed.length) {
          anomalies.push(
            `${other.accountId} @ ${toIsoDate(other.createdDate)}: ${failed.join(', ')}`,
          );
        }
      }
      if (anomalies.length) {
        test.info().annotations.push({
          type: 'older-rendering-anomaly',
          description:
            `${anomalies.length} of ${scan.length} older ${type} renderings fail a check ` +
            `that the newest one passes. Not failing the run — but worth a look:\n` +
            anomalies.join('\n'),
        });
        console.log(`\n[TS-03] ${type} — ${anomalies.length}/${scan.length} older renderings differ:`);
        anomalies.forEach((a) => console.log(`   ${a}`));
      }
    });
  }


  /**
   * Case 7.5 — fiscal identifiers, asserted against the CONFIGURED stamping state.
   *
   * Written state-aware rather than as a two-state test on purpose. Stamping is
   * tenant-global and its config tables are empty, so the "on" state cannot be
   * produced here — and flipping `pacEnabled` alone would not produce it either.
   *
   * What this asserts in either state is one invariant: THE DATA AGREES WITH THE
   * CONFIG. That is meaningful now, and it catches the mistake that actually
   * happened during manual testing — `foliostatus = NULL` was read as a defect
   * when it is correct with stamping off.
   *
   * The day the PAC config is completed and the flag flipped, the on-branch starts
   * asserting with no code change.
   */
  /**
   * The low-balance warning ("saldo próximo a agotarse", TC-70..78) can only reach a
   * real prepaid customer if the PREPAID credit profile carries the thresholds. The
   * live cases (ts-02 / ts-05) stage on whatever account has a threshold - in
   * practice the POSTPAID Default Credit Profile - so they prove the email copy, not
   * that a prepaid customer is ever warned. This is the check that does.
   *
   * Agreed values: -4000|-2000 on the Prepaid Energy Profile (JEPYP-319 Q1, Tri,
   * 2026-10-08). NULL on prod and preprod that day: the tenant-deployment baseline
   * writes NULL on every re-apply. Fix requested from the team 2026-10-08.
   */
  test('the Prepaid Energy Profile carries the agreed warning thresholds @saldo-config', async () => {
    const profiles = await db.query<{ id: string; valuethreshold: string | null }>(
      `SELECT id, valuethreshold FROM core_config.credit_profiles
        WHERE id LIKE '%-CRPRE' AND currency = 'CRC'`,
    );
    const flag = await db.query<{ value: string }>(
      `SELECT value FROM core_config.ccp_properties WHERE property = 'prepaidThresholdEnrichEnabled'`,
    );
    console.log(`[TS-03] Prepaid Energy Profile: ${JSON.stringify(profiles)} | prepaidThresholdEnrichEnabled=${flag[0]?.value}`);
    blockedIf(!profiles.length, `no <tenant>-CRPRE CRC credit profile on "${connectedDb}"`);
    for (const p of profiles) {
      expect.soft(p.valuethreshold, `${p.id} valuethreshold - a prepaid customer is never warned without it ` +
        `(agreed -4000|-2000, JEPYP-319 Q1; reported 2026-10-08)`).toBe('-4000|-2000');
    }
    expect.soft(String(flag[0]?.value ?? '').trim().toLowerCase(),
      'ccp prepaidThresholdEnrichEnabled - gates the prepaid warning messages 1/2/3 (JEPYP-50)').toBe('true');
  });

  test('7.5 — fiscal identifiers match the configured stamping state', async () => {
    const stamping = await notifyDb.getStampingState();
    const invoices = await notifyDb.getInvoiceArtifacts({ sinceMinutes: 60 * 24 * 400 });

    console.log(
      `\n[TS-03] pacEnabled = ${stamping.rawValue} (${stamping.enabled ? 'ON' : 'OFF'}) | ` +
      `PAC config present: ${stamping.configured} | ` +
      Object.entries(stamping.configCounts).map(([k, v]) => `${k}=${v}`).join(' '),
    );

    const stamped = invoices.filter((i) => i.folioStatus === 'STAMPED');
    const withFolio = invoices.filter((i) => i.folioId);
    console.log(
      `[TS-03] invoices ${invoices.length} | STAMPED ${stamped.length} | with folioid ${withFolio.length}`,
    );

    test.info().annotations.push({
      type: 'stamping-state',
      description:
        `pacEnabled=${stamping.rawValue}; config present=${stamping.configured}; ` +
        `invoices=${invoices.length}, STAMPED=${stamped.length}, withFolio=${withFolio.length}`,
    });

    if (!stamping.enabled) {
      // OFF branch: no invoice should carry a folio. Anything that does is either a
      // seeded row or stamping half-running — both worth knowing about.
      if (withFolio.length) {
        test.info().annotations.push({
          type: 'pre-existing-folio',
          description:
            `${withFolio.length} invoice(s) carry a folio despite pacEnabled=false: ` +
            withFolio.map((i) => `${i.id} (${i.folioStatus}, acct ${i.accountId})`).join('; ') +
            `. pac_interface_record has 0 rows, so no PAC call was ever recorded for them — ` +
            `most likely seeded or predating the flag being turned off.`,
        });
      }
      // Assert on RECENT invoices only, so one legacy row cannot hold this red forever.
      const recent = invoices.slice(0, 50);
      const recentWithFolio = recent.filter((i) => i.folioId);
      expect
        .soft(
          recentWithFolio.length,
          `pacEnabled=false but ${recentWithFolio.length} of the 50 newest invoices carry a ` +
          `folio: ${recentWithFolio.map((i) => i.id).join(', ')}. Either stamping runs while ` +
          `disabled, or pacEnabled is not the real switch.`,
        )
        .toBe(0);

      test.info().annotations.push({
        type: 'deferred',
        description:
          'ON-branch NOT executed: pacEnabled=false and the PAC config tables are empty, ' +
          'so the stamped state cannot be produced on this environment. Report case 7.5 ' +
          'stays Pending — blocked on environment config, not on the automation.',
      });
      return;
    }

    // ON branch — unreachable on this environment today. Encoded so it activates
    // itself once the config lands.
    expect.soft(invoices.length, 'pacEnabled=true but no invoices to check').toBeGreaterThan(0);
    for (const inv of invoices.slice(0, 20)) {
      expect.soft(inv.folioStatus, `${inv.id} should be STAMPED with pacEnabled=true`).toBe('STAMPED');
      const digits = (inv.folioId ?? '').replace(/\D/g, '');
      expect
        .soft(digits.length, `${inv.id} folioid should be a 50-digit clave, got ${digits.length}`)
        .toBe(50);
      // The Costa Rican clave embeds the emisor cedula juridica (JASEC = 3007045087).
      expect
        .soft(digits.includes('3007045087'), `${inv.id} clave should embed the emisor cedula`)
        .toBe(true);
    }
  });

  /**
   * Cases 7.2 / 7.4 — invoice PDF content, read from the email attachment.
   *
   * The PDF is NOT in the database (`invoice_unit.filepath` and `invoicebase64pdf`
   * are NULL on every invoice), so IMAP is the only route to it.
   *
   * NOT blocked by stamping: PDFs generate with `pacEnabled=false`, and stamping is
   * not visible in the PDF at all — verified on a real 106 KB invoice containing no
   * clave, consecutivo or Hacienda reference.
   *
   * Skips cleanly when NOTIFY_IMAP_* is unset, so the rest of this suite stays
   * runnable with database access alone.
   */
  test('7.2 / 7.4 — invoice PDF is valid and its fields are populated', async () => {
    test.skip(
      !process.env.NOTIFY_IMAP_USER || !process.env.NOTIFY_IMAP_PASSWORD,
      'NOTIFY_IMAP_* not configured — PDF assertions need the mailbox.',
    );
    test.setTimeout(900_000);

    const emailHelper = new EmailHelper();
    await emailHelper.connect();
    let invoiceEmails: ParsedEmail[];
    try {
      invoiceEmails = await emailHelper.searchEmails({
        match: (e) => /Factura|Estado de Cuenta/i.test(e.subject) && e.pdfAttachment() !== null,
        since: new Date('2026-08-01'),
        limit: 3,
      });
    } finally {
      await emailHelper.disconnect();
    }

    expect(invoiceEmails.length, 'no invoice email with a PDF attachment found').toBeGreaterThan(0);

    const email = invoiceEmails[0];
    const pdf = email.pdfAttachment()!;
    const summary = describePdf(pdf.content);
    console.log(`\n[TS-03] ${pdf.filename} — ${summary.verdict}`);

    // 7.2 — the attachment is a complete document, not a truncated render.
    expect.soft(summary.valid, `${pdf.filename}: ${summary.verdict}`).toBe(true);
    if (!summary.valid) return;

    const text = await extractPdfText(pdf.content);
    const fields = {
      identificacion: pdfField(text, 'Identificacion'),
      cuenta: pdfField(text, 'Cuenta'),
      cliente: pdfField(text, 'Cliente'),
      ubicacion: pdfField(text, 'Ubicacion'),
      diasFacturados: pdfField(text, 'Dias facturados'),
      consumo: pdfField(text, 'Consumo (kWh)'),
    };
    console.log('[TS-03] PDF fields:');
    Object.entries(fields).forEach(([k, v]) => console.log(`   ${k.padEnd(16)} "${v}"`));

    const accountId = fields.cuenta;
    // Not a known defect — the account number does render, so this stays blocking.
    expect.soft(accountId, 'PDF has no Cuenta value').not.toBe('');

    // 7.4 — the three field defects found by hand, now asserted automatically.
    // Each carries its knownDefect note so the project is not permanently red;
    // remove the note when the fix lands and the check becomes blocking.
    // FIXED 2026-08-13 — now BLOCKING, so a regression is caught.
    // Was rendering JASEC's own cedula juridica (3007045087) for every customer.
    // Verified on invoice 000203: renders the account's own contact.identity.
    checkPdfField(
      fields.identificacion !== '3007045087',
      'Identificacion',
      `shows "${fields.identificacion}", which is JASEC's own cedula juridica, not the ` +
      `customer's — the account on this invoice is ${accountId}`,
    );

    // Per dev, the line is OMITTED when contact.identity is null — that is the rule
    // CoopeG uses too, so an absent line is a data gap, not a template defect.
    // Only 14 of 586 contacts have identity populated, so record it rather than fail.
    if (!fields.identificacion) {
      test.info().annotations.push({
        type: 'data-gap',
        description:
          `No Identificacion line on this invoice — contact.identity is not set for ` +
          `${accountId}. Expected per dev (same rule as CoopeG), but it means the ` +
          `document carries no customer identification.`,
      });
    }

    // STILL OPEN. The empty-comma artefact (", , Costa Rica") is gone, but only the
    // country renders. Both test accounts hold street "Colon 111", city "Cartago",
    // state "Cartago", postalcode "30101" — so the template reads the address row
    // (CRI maps to "Costa Rica" correctly) and drops everything except country.
    checkPdfField(
      fields.ubicacion.replace(/[,\s]/g, '') !== 'CostaRica',
      'Ubicacion',
      `shows only the country ("${fields.ubicacion}") — street, city, state and ` +
      `postcode are dropped even though the address row holds them`,
      'JEPYP-230 case 7.4 — Ubicacion still open after the 2026-08-13 fix',
    );

    // FIXED 2026-08-13 — now BLOCKING. Verified 57 on inv 000203, 56 on inv 000365.
    checkPdfField(
      fields.diasFacturados !== '',
      'Dias facturados',
      'renders blank',
    );

    test.info().annotations.push({
      type: 'pdf-checked',
      description:
        `${pdf.filename} (${summary.bytes} bytes) - account ${accountId} - ` +
        `Identificacion="${fields.identificacion}" Ubicacion="${fields.ubicacion}" ` +
        `DiasFacturados="${fields.diasFacturados}" Consumo="${fields.consumo}"`,
    });
  });

  /**
   * JEPYP-54 — the invoice mail delivers the invoice document.
   *
   * WHY THIS IS SEPARATE FROM 7.2/7.4. That case reads `pdfAttachment()`, which
   * returns the FIRST pdf, so it can check that document but never how MANY
   * arrived. Nothing in the suite counted attachments before this. Different
   * claim, so a different case — and keeping 7.2/7.4 untouched matters more than
   * the extra IMAP fetch, since it is an official case that passes.
   *
   * RE-SCOPED 2026-09-10 — READ THIS BEFORE RE-RAISING THE STATEMENT.
   *
   * First written to assert TWO documents, because JEPYP-54 is titled "Email
   * Invoice and Account Statement PDF files" and the subject line reads "Factura
   * y Estado de Cuenta". It failed, correctly: measured across the 6 newest
   * invoice mails on 2026-09-09, every one carried `logo.png` plus a single
   * `INVOICE_ACT-*.pdf` and no statement.
   *
   * The team's answer is that the account statement is NOT part of the flow —
   * "I don't think we run account statement, that template may not be needed and
   * it inherits from Coope" (Tri Do, 2026-09-10). That matches the observation, so
   * the missing statement is SCOPE, not a defect, and this case now asserts what
   * the product is actually meant to deliver: exactly one document, the invoice.
   *
   * `toBe(1)` rather than `>= 1` is deliberate. It still catches the regression
   * this case exists for (the invoice stops attaching), and it ALSO catches the
   * scope changing back — if a statement is implemented later this goes red and
   * tells us to update the expectation rather than silently passing.
   *
   * STILL OPEN, tracked elsewhere, not asserted here: `jasec_consumption_statement_v1.xsl`
   * remains ACTIVE in `core_config.template_files` and carries CoopeGuanacaste's
   * contact details (servicioalcliente@coopeguanacaste.com, 2681-4701) as its only
   * email and phone. An unused template that is still switched on can still be
   * picked up. We have asked for it to be set INACTIVE.
   *
   * Soft throughout, so one run reports the count AND the document's validity
   * rather than stopping at the first miss.
   */
  test('JEPYP-54 — the invoice mail delivers exactly one document, the invoice', async () => {
    test.skip(
      !process.env.NOTIFY_IMAP_USER || !process.env.NOTIFY_IMAP_PASSWORD,
      'NOTIFY_IMAP_* not configured — attachment assertions need the mailbox.',
    );
    test.setTimeout(900_000);

    const emailHelper = new EmailHelper();
    await emailHelper.connect();
    let emails: ParsedEmail[];
    try {
      emails = await emailHelper.searchEmails({
        // Deliberately NOT filtered on having a pdf, unlike 7.2/7.4: a mail that
        // delivered NO document is exactly the failure this case must be able to
        // see, and filtering it out would hide it.
        match: (e) => /Factura|Estado de Cuenta/i.test(e.subject),
        since: new Date(process.env.NOTIFY_ATTACH_SINCE ?? '2026-08-01'),
        limit: 5,
      });
    } finally {
      await emailHelper.disconnect();
    }

    expect(
      emails.length,
      'no invoice mail found to inspect — widen NOTIFY_ATTACH_SINCE',
    ).toBeGreaterThan(0);

    const rows = ['| # | attachments | PDFs | filenames |', '|---|---|---|---|'];
    emails.forEach((e, i) => {
      rows.push(
        `| ${i} | ${e.attachments.length} | ${e.pdfAttachments().length} | ` +
        `${e.attachments.map((a) => a.filename).join(', ')} |`,
      );
    });
    console.log(`\n[TS-03] JEPYP-54 attachment inventory\n${rows.join('\n')}\n`);

    // Assert on the NEWEST mail only. Asserting across all five would let one
    // legacy message hold this red after the fix lands.
    const newest = emails[0];
    const pdfs = newest.pdfAttachments();

    // Classify by what the file IS, not by position — the annotation and the
    // failure messages stay readable whichever way the count goes wrong.
    const invoiceLike = pdfs.filter((p) => /invoice|factura/i.test(p.filename));
    const otherLike = pdfs.filter((p) => !/invoice|factura/i.test(p.filename));

    expect
      .soft(
        pdfs.length,
        pdfs.length === 0
          ? `"${newest.subject}" carries NO pdf at all ` +
            `[${newest.attachments.map((a) => a.filename).join(', ') || 'nothing'}]. ` +
            `The customer has no invoice.`
          : `"${newest.subject}" carries ${pdfs.length} PDFs ` +
            `[${pdfs.map((p) => p.filename).join(', ')}]. Exactly ONE is expected: the ` +
            `account statement is not part of this flow (confirmed 2026-09-10). If a ` +
            `statement has since been implemented, update this expectation to 2 and ` +
            `add the statement-document assertions — do not just relax the count.`,
      )
      .toBe(1);

    // The document that IS attached must be complete, not a truncated render.
    for (const pdf of pdfs) {
      const summary = describePdf(pdf.content);
      expect.soft(summary.valid, `${pdf.filename}: ${summary.verdict}`).toBe(true);
    }

    // The one document must be the INVOICE. Without this, a run that attached
    // only a statement — or only the logo re-typed as a pdf — would satisfy the
    // count above and still leave the customer without an invoice.
    expect
      .soft(
        invoiceLike.length,
        `no invoice document among the attachments ` +
        `[${pdfs.map((p) => p.filename).join(', ') || 'none'}] — expected a filename ` +
        `like INVOICE_ACT-<account>_<number>_<date>.pdf`,
      )
      .toBe(1);

    test.info().annotations.push({
      type: 'jepyp-54-attachments',
      description:
        `${newest.attachments.length} attachment(s), ${pdfs.length} PDF(s) — ` +
        `invoice [${invoiceLike.map((p) => p.filename).join(', ') || 'none'}], ` +
        `other [${otherLike.map((p) => p.filename).join(', ') || 'none'}]. ` +
        `"other" is expected to stay empty: the account statement is out of scope.`,
    });
  });

  /**
   * JEPYP-45 — the JARS / MiPOS electronic document itself.
   *
   * 7.5 above asserts folio STATE against `pacEnabled`. It says nothing about the
   * DOCUMENT, and the document is what goes to Hacienda — so a regression there is
   * a regulatory problem, not a cosmetic one. JEPYP-45's acceptance criterion is
   * literally "validate the integration"; until this case the only evidence was a
   * payload decoded by hand.
   *
   * READ-ONLY, and it works with `pacEnabled=false` because it asserts on calls
   * that already happened (49 on jasec-dev, 2026-07-16 .. 2026-08-10).
   *
   * ***NEVER ENABLE pacEnabled ON DEV TO FEED THIS CASE.*** Confirmed by Huy
   * 2026-09-10: `https://jasec.mipos.co.cr/` is **JASEC's PRODUCTION MiPOS**. There
   * is no sandbox, despite JEPYP-45's description labelling it "Sandbox ENV". So the
   * stamping gateway on dev points at a LIVE tax-document system, and turning the
   * flag on would push test documents into it. (The 49 calls above already reached
   * production — that is history, not a licence to add more.)
   *
   * Consequence for the plan: stamping is not "blocked pending pacEnabled", it is
   * **not verifiable on dev at all**. TC-90 (case 7.5) and the XML half of TC-87
   * inherit that. This case is deliberately built to need none of it — it reads
   * calls already recorded in the gateway log.
   *
   * THE STRONGEST AVAILABLE CHECK IS THE `Clave`. Costa Rica packs the issuer, the
   * emission date and the consecutivo INTO the key, so it must agree with the
   * document's own fields — a mismatch means the gateway assembled the key from
   * something other than the invoice it claims to represent. Decomposition
   * verified against the 2026-08-10 document:
   *
   *   50610082600300704508700200070040000000017197193004
   *   506 | 100826 | 003007045087 | 00200070040000000017 | 1 | 97193004
   *   CR  | DDMMYY | emisor(12)   | NumeroConsecutivo    | s | security code
   *
   * NOTE ON TOTALS. The newest document predates the 2026-09-07 rate fix and
   * carries the OLD rates (ENERGIA 69.24, CVG ENERGIA +4.81 as a charge rather
   * than a credit, total 2,319.30). So this case asserts the document's INTERNAL
   * arithmetic, which holds in any era, and merely REPORTS the rates. Asserting
   * 1,943.40 here would fail on a historical document for the wrong reason.
   */
  test('JEPYP-45 — the JARS document is well formed and self consistent', async () => {
    const calls = await notifyDb.getJarsStampingCalls(10);
    const documented = calls.filter((c) => c.xml);

    console.log(
      `\n[TS-03] JARS calls read: ${calls.length}, of which ${documented.length} ` +
      `returned a document` +
      (calls.length ? ` (newest ${calls[0].endDate})` : ''),
    );

    // An env that has never exercised the integration is an unmet precondition,
    // not a product failure — print the reason and skip rather than fail.
    test.skip(
      documented.length === 0,
      calls.length === 0
        ? 'BLOCKED: no JARS calls in core_gateway.gateway_provider_log on this tenant — ' +
          'the stamping integration has never run here, so there is nothing to assert.'
        : `BLOCKED: ${calls.length} JARS call(s) exist but none returned a document ` +
          '(every response lacked a "data" key), so there is no XML to assert on.',
    );

    const call = documented[0];
    const xml = call.xml!;
    console.log(`[TS-03] asserting on the ${call.endDate} ${call.api} document (${xml.length} bytes)`);

    // ── shape ────────────────────────────────────────────────────────────
    const imbalance = xmlImbalance(xml);
    expect
      .soft(imbalance, `JARS document is not well formed: ${imbalance}`)
      .toBe('');
    expect
      .soft(
        /<TiqueteElectronico[\s>]/.test(xml),
        'JARS document root is not <TiqueteElectronico> — Costa Rica expects a ' +
        'TiqueteElectronico (or FacturaElectronica) for this document type',
      )
      .toBe(true);

    // ── the Clave must agree with the document's own fields ──────────────
    const clave = xmlValue(xml, 'Clave');
    const consecutivo = xmlValue(xml, 'NumeroConsecutivo');
    const fechaEmision = xmlValue(xml, 'FechaEmision');
    const emisor = String(call.request.emisor ?? '');

    expect.soft(clave, 'document carries no <Clave>').not.toBe('');
    expect
      .soft(clave.length, `Clave is ${clave.length} chars, Hacienda requires exactly 50: ${clave}`)
      .toBe(50);
    expect.soft(/^[0-9]+$/.test(clave), `Clave is not all digits: ${clave}`).toBe(true);

    if (clave.length === 50) {
      expect
        .soft(clave.slice(0, 3), `Clave country prefix is ${clave.slice(0, 3)}, expected 506 (CR)`)
        .toBe('506');

      // FechaEmision 2026-08-10T07:29:13 -> DDMMYY 100826
      const iso = fechaEmision.slice(0, 10);
      const ddmmyy = `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(2, 4)}`;
      expect
        .soft(
          clave.slice(3, 9),
          `Clave date segment ${clave.slice(3, 9)} does not match FechaEmision ` +
          `${fechaEmision} (expected DDMMYY ${ddmmyy}) — the key was built from a ` +
          `different date than the document states`,
        )
        .toBe(ddmmyy);

      if (emisor) {
        expect
          .soft(
            clave.slice(9, 21),
            `Clave issuer segment ${clave.slice(9, 21)} does not match the emisor we ` +
            `SENT (${emisor}, padded ${emisor.padStart(12, '0')})`,
          )
          .toBe(emisor.padStart(12, '0'));
      }

      expect
        .soft(
          clave.slice(21, 41),
          `Clave consecutivo segment ${clave.slice(21, 41)} does not match ` +
          `<NumeroConsecutivo>${consecutivo}</NumeroConsecutivo>`,
        )
        .toBe(consecutivo);
    }

    // ── tenant config agreement ──────────────────────────────────────────
    const activityXml = xmlValue(xml, 'CodigoActividadEmisor');
    const activityCfg =
      (await notifyDb.getCcpProperty('stampingActivityCodePrepaid')) ??
      (await notifyDb.getCcpProperty('stampingActivityCode'));
    if (activityCfg) {
      expect
        .soft(
          Number(activityXml),
          `document CodigoActividadEmisor=${activityXml} but ccp_properties says ` +
          `${activityCfg} — the economic activity code reported to Hacienda does not ` +
          `match tenant config`,
        )
        .toBe(Number(activityCfg));
    }
    expect
      .soft(xmlValue(xml, 'CodigoMoneda'), 'document currency is not CRC')
      .toBe('CRC');

    // ── internal arithmetic: era independent, so safe to assert ──────────
    const lineTotals = xmlValues(xml, 'MontoTotalLinea');
    const totalVenta = num2dp(xmlValue(xml, 'TotalVenta'));
    const totalDescuentos = num2dp(xmlValue(xml, 'TotalDescuentos') || '0');
    const totalVentaNeta = num2dp(xmlValue(xml, 'TotalVentaNeta'));
    const totalImpuesto = num2dp(xmlValue(xml, 'TotalImpuesto') || '0');
    const totalComprobante = num2dp(xmlValue(xml, 'TotalComprobante'));

    expect
      .soft(
        sum2dp(lineTotals),
        `sum of ${lineTotals.length} MontoTotalLinea values (${sum2dp(lineTotals)}) != ` +
        `TotalVenta (${totalVenta})`,
      )
      .toBe(totalVenta);
    expect
      .soft(
        totalVentaNeta,
        `TotalVentaNeta (${totalVentaNeta}) != TotalVenta - TotalDescuentos ` +
        `(${totalVenta} - ${totalDescuentos})`,
      )
      .toBe(num2dp(String(totalVenta - totalDescuentos)));
    expect
      .soft(
        totalComprobante,
        `TotalComprobante (${totalComprobante}) != TotalVentaNeta + TotalImpuesto ` +
        `(${totalVentaNeta} + ${totalImpuesto})`,
      )
      .toBe(num2dp(String(totalVentaNeta + totalImpuesto)));

    // Line count must match what we sent — a dropped line would still balance
    // arithmetically if its amount were zero.
    const sentLines = Array.isArray(call.request.detalleServicio)
      ? call.request.detalleServicio.length
      : null;
    if (sentLines !== null) {
      expect
        .soft(
          lineTotals.length,
          `document has ${lineTotals.length} detail line(s) but we sent ${sentLines}`,
        )
        .toBe(sentLines);
    }

    // ── reported, not asserted ───────────────────────────────────────────
    // The issuer email is the FIFTH place JEPYP-266's address change has to
    // land (the four templates are the others) and it does NOT come from any
    // XSL, so fixing the templates leaves this document still wrong. Recorded
    // rather than asserted because JEPYP-266 is Backlog/To do.
    const issuerEmail = xmlValue(xml, 'CorreoElectronico');
    console.log(
      `[TS-03] JARS document — Clave ${clave}\n` +
      `        consecutivo ${consecutivo}  emitted ${fechaEmision}  activity ${activityXml}\n` +
      `        lines ${lineTotals.length}  TotalVenta ${totalVenta}  ` +
      `TotalImpuesto ${totalImpuesto}  TotalComprobante ${totalComprobante}\n` +
      `        issuer email ${issuerEmail || '(absent)'}`,
    );
    test.info().annotations.push({
      type: 'jepyp-45-document',
      description:
        `${call.endDate} ${call.api}: Clave=${clave} consecutivo=${consecutivo} ` +
        `lines=${lineTotals.length} TotalComprobante=${totalComprobante} ` +
        `issuerEmail=${issuerEmail || '(absent)'}. Detail lines: ` +
        `${xmlValues(xml, 'Detalle').join(' || ')}`,
    });
    if (issuerEmail && issuerEmail !== 'atencionalcliente@jasec.go.cr') {
      test.info().annotations.push({
        type: 'jepyp-266-pending',
        description:
          `Document issuer CorreoElectronico is "${issuerEmail}"; JEPYP-266 asks for ` +
          `atencionalcliente@jasec.go.cr. This value is emisor config, NOT any XSL ` +
          `template, so the template changes alone will not fix the document sent to ` +
          `Hacienda.`,
      });
    }
  });

  /**
   * Coverage summary — which types exist, how many rows, and the SUCCESS/FAILED
   * split. This is the number behind the §9.1 SMTP finding, so it is worth
   * having recorded on every run rather than re-derived by hand.
   */
  test('coverage — row counts and SMTP split per type', async () => {
    // An empty table is an unmet PRECONDITION - there is nothing to replay - so it
    // is BLOCKED, not FAILED (it used to fail here; JASEC prod, 2026-09-30, 0 rows).
    // Say loudly and specifically why, rather than a per-type miss for all nine
    // templates. On a tenant that HAS had top-ups, zero rows is itself a finding:
    // check whether notifications are being created at all.
    if (blockedIf(
      totalRows === 0,
      `core_engine.email_notification is EMPTY on "${connectedDb}" - nothing to replay. ` +
      `This suite replays existing notifications. If this tenant has had top-ups or ` +
      `failed MDR files, zero rows means notifications are not being CREATED - check ` +
      `that before anything else. Otherwise point DB_NAME at a tenant that has some.`,
    )) return;

    const all = await notifyDb.getNotifications({});
    const byType = new Map<string, { total: number; failed: number }>();
    for (const r of all) {
      const e = byType.get(r.type) ?? { total: 0, failed: 0 };
      e.total += 1;
      if (r.status === 'FAILED') e.failed += 1;
      byType.set(r.type, e);
    }

    const lines = ['| Type | Rows | FAILED | Failure rate |', '|---|---|---|---|'];
    for (const [type, e] of [...byType.entries()].sort()) {
      lines.push(`| ${type} | ${e.total} | ${e.failed} | ${((e.failed / e.total) * 100).toFixed(1)}% |`);
    }
    const table = lines.join('\n');
    console.log(`\n${table}\n`);

    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, 'replay-coverage.md');
    fs.writeFileSync(file, table, 'utf-8');
    await test.info().attach('replay-coverage.md', { path: file, contentType: 'text/markdown' });

    // Every template we ship should have at least one rendering to replay,
    // except the ones with a tracked logging defect.
    // A type with no rows has nothing to REPLAY - the replay never ran, so it
    // found no defect and proves nothing. That is missing coverage, which is a
    // different report from a failure and must not be counted as one.
    //
    // Listing them beats blocking the whole case on the first gap: this test's
    // job is to say WHICH templates are unproven, and it can still say that for
    // the rest. So collect, print, and block only if something is missing.
    const missing = Object.keys(TEMPLATES)
      .filter((type) => !EXPECTED_MISSING[type] && !byType.has(type));
    if (blockedIf(
      missing.length > 0,
      `no email_notification rows to replay for: ${missing.join(', ')}. ` +
      `Nothing on this tenant has produced these notifications yet, so their ` +
      `rendering is UNPROVEN rather than wrong.`,
    )) return;
  });
});

/**
 * Assert a PDF field, honouring the repo's known-defect convention.
 *
 * A check carrying `knownDefect` still runs and is still reported, but does NOT
 * fail the run — the same rule the template FieldChecks use (test-data/
 * notifications/types.ts). Without this, the three open 7.4 defects would hold the
 * whole project red permanently and nobody would trust it as a gate.
 *
 * Delete the `knownDefect` argument when a fix lands and the check becomes
 * blocking, which is what catches a later regression.
 */
// ── JARS document helpers (JEPYP-45) ─────────────────────────────────────────
//
// Deliberately dependency-free: no XML parser is installed and adding one to a
// PUBLIC repo for three field reads is not worth it. The JARS document is flat,
// so a tag scan is honest — provided we are precise about what it does and does
// not prove. See `xmlImbalance` for the limits.

/** First value of a simple element, '' when absent. */
function xmlValue(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1].trim() : '';
}

/** Every value of a repeated element, in document order. */
function xmlValues(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Tag-balance check. Returns '' when balanced, else what went wrong.
 *
 * This is NOT schema validation and NOT a full parser. What it does prove is
 * that the document is not truncated and that elements nest correctly — which is
 * what a broken gateway response actually looks like in practice. It would not
 * notice a wrong namespace or a field in the wrong order, so do not describe a
 * pass here as "valid against the Hacienda schema".
 *
 * Known limit: an attribute value containing ">" would confuse the tag regex.
 * The JARS document's only attributes are xmlns URLs, which contain none.
 */
function xmlImbalance(xml: string): string {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][A-Za-z0-9:._-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const closing = m[1];
    const name = m[2];
    const selfClose = m[4];
    if (selfClose === '/') continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) return `</${name}> closes <${open ?? 'nothing'}>`;
    } else {
      stack.push(name);
    }
  }
  return stack.length ? `unclosed: ${stack.join(' > ')}` : '';
}

/** Sum a list of numeric strings, rounded to 2dp so float noise cannot fail a check. */
function sum2dp(values: string[]): number {
  return Math.round(values.reduce((t, v) => t + Number(v), 0) * 100) / 100;
}

/** Round one numeric string to 2dp. */
function num2dp(value: string): number {
  return Math.round(Number(value) * 100) / 100;
}

function checkPdfField(
  ok: boolean,
  label: string,
  detail: string,
  knownDefect?: string,
): void {
  if (ok) return;
  if (knownDefect) {
    test.info().annotations.push({
      type: 'known-defect',
      description: `${label}: ${detail} — ${knownDefect}`,
    });
    console.log(`   [known defect] ${label}: ${detail}`);
    return;
  }
  expect.soft(ok, `${label}: ${detail}`).toBe(true);
}

/** Contact name for the greeting check. Best-effort — absent is not fatal. */
async function lookupName(accountId: string): Promise<{ firstName: string; lastName: string }> {
  const rows = await db.query<{ firstname: string; lastname: string }>(
    `SELECT firstname, lastname FROM core_engine.contact
      WHERE accountid = $1 ORDER BY id LIMIT 1`,
    [accountId],
  );
  return { firstName: rows[0]?.firstname ?? '', lastName: rows[0]?.lastname ?? '' };
}

function toIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

