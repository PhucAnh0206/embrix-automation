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

const outDir = path.join(process.cwd(), 'test-results', 'notification-reports');

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
      const rows = await notifyDb.getNotifications({ type });

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
   * Coverage summary — which types exist, how many rows, and the SUCCESS/FAILED
   * split. This is the number behind the §9.1 SMTP finding, so it is worth
   * having recorded on every run rather than re-derived by hand.
   */
  test('coverage — row counts and SMTP split per type', async () => {
    // Fail loudly and specifically on an empty table rather than reporting a
    // per-type miss for all nine templates — the cause is the connection, not
    // the templates.
    expect(
      totalRows,
      `core_engine.email_notification is EMPTY on "${connectedDb}". This suite ` +
      `replays existing notifications, so it needs a database that has some. ` +
      `Point DB_NAME at coredb-jasec-dev (switch-env.ps1 dev, or DB_NAME=... inline).`,
    ).toBeGreaterThan(0);

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
    for (const type of Object.keys(TEMPLATES)) {
      if (EXPECTED_MISSING[type]) continue;
      expect
        .soft(byType.has(type), `no email_notification rows for ${type} — cannot replay it`)
        .toBe(true);
    }
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

