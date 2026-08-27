/**
 * TS-01 — Notifications (JEPYP-230)
 *
 * Tests:
 *   4.1  Top-Up Confirmation email — field-by-field content check (JEPYP-49)
 *
 * Creates a fresh prepaid account whose billing contact carries the
 * IMAP-monitored address, triggers the event, waits for the email, then
 * asserts every field defined by the template.
 *
 * The account id is unique per run and appears in the body, so the email is
 * matched on it — never on subject alone. That is what stops a re-run from
 * asserting against a stale message from a previous run.
 *
 * Output: a Jira-ready 3-column table, written to
 * test-results/notification-reports/ and attached to the HTML report.
 *
 * FUTURE TEMPLATES (JEPYP-50 low balance, -51 balance ended, -52 reconnection,
 * -53 minimum top-up, -54 invoice + statement): add a template file next to
 * topup-confirmation.template.ts and a test below that triggers the event.
 * EmailHelper, NotificationReportHelper and the report format need no changes.
 *
 * Requires: VPN (DB + IMAP), NOTIFY_* env vars — see docs/NOTIFICATION_TESTS.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import {
  setUpAccountForTopUp,
  attachToAccountInSelfCare,
  type PrepaidAccountWithOrderRow,
} from '../../../../fixtures/create-prepaid-account.helper';
import { EmailHelper, type ParsedEmail } from '../../../../helpers/email.helper';
import { NotificationDbHelper } from '../../../../helpers/notification-db.helper';
import { NotificationReportHelper } from '../../../../helpers/notification-report.helper';
import { topUpConfirmationTemplate } from '../../../../test-data/notifications/topup-confirmation.template';
import type { NotificationContext } from '../../../../test-data/notifications/types';

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const dataRows: PrepaidAccountWithOrderRow[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const baseRow = dataRows[0];

/**
 * Top-up amount. 5000 CRC clears the additional-recharge minimum and yields a
 * non-zero `Saldo kWh Aproximados`, so the kWh check actually proves something
 * (a small amount truncates to 0 and would pass vacuously).
 */
const TOP_UP_AMOUNT = 5000;

/**
 * The two top-up channels, and what each writes as `ID Transacción`.
 *
 * They are DIFFERENT CODE PATHS writing different references to
 * `core_engine.subscription_topup.paymentrefid`, so covering one says nothing
 * about the other. Until now only Pay Now was exercised, and the sheet's claim
 * that PlaceToPay "also notifies through email" was a manual observation with no
 * automated guard — if that channel stopped sending, the suite stayed green.
 *
 * The template itself is channel-agnostic (its ID Transacción check accepts all
 * three formats, including the numeric cash receipt), so each test pins its OWN
 * channel's format here rather than relying on the template to tell them apart.
 */
const CHANNELS = {
  payNow: {
    case: '2.1a',
    label: 'Pay Now (saved card)',
    // `\\S` not `\S`: inside a template literal `\S` is an unrecognised escape and
    // collapses to a bare `S`, giving `^TU-<acct>-S+$` — which matches nothing and
    // would have made this test silently fall back to the DB on every run.
    // Verified against the real reference TU-ACT-100573-90f2589e8b86.
    ref: (accountId: string) => new RegExp(`^TU-${accountId}-\\S+$`),
    refShape: (accountId: string) => `TU-${accountId}-<hex>`,
  },
  placeToPay: {
    case: '2.1b',
    label: 'Pay with PlaceToPay',
    ref: (accountId: string) => new RegExp(`^TOPUP-${accountId}-[0-9]+$`),
    refShape: (accountId: string) => `TOPUP-${accountId}-<epochms>`,
  },
} as const;

/**
 * One account shared by both channel tests.
 *
 * Account creation through Self Care is the slowest thing in this spec (~8 of the
 * ~12 minutes), and both cases are top-up confirmations on a prepaid account —
 * nothing about either requires a pristine one. Creating it once halves the run.
 *
 * Cleared implicitly when Playwright restarts the worker after a failure, in
 * which case the next test simply creates a fresh account instead of failing on
 * missing state. That is why this is a lazy getter and not a beforeAll.
 */
let sharedAccount: {
  accountId: string;
  row: PrepaidAccountWithOrderRow;
  ccpDate: string;
} | null = null;

/**
 * Create the shared prepaid account, or hand back the one already created.
 *
 * Also owns the CCP move, because it has to happen BEFORE account creation:
 * top-ups stamped at the current date are the ones observed to produce a
 * notification, so the account is created under those conditions rather than the
 * jasecCcpBaseline the auto-fixture parks at.
 *
 * FORWARD ONLY. An earlier version set the clock to real-today unconditionally,
 * reasoning that this is always forward OF THE BASELINE. It is not always forward
 * of the CLOCK: the tenant clock is frozen and routinely parked months ahead
 * (2027-01-09 while today was 2026-08-13), so that set moved it BACKWARD, which
 * the runbook warns can corrupt cycle state.
 */
async function ensureAccount(f: any): Promise<{
  accountId: string; row: PrepaidAccountWithOrderRow; ccpDate: string;
}> {
  if (sharedAccount) {
    // The ACCOUNT is shared; the BROWSER SESSION is not. Playwright gives each test
    // a fresh page, so 2.1a's Self Care login does not carry over — the reuse path
    // has to log in and re-select the account or the very first navigation fails on
    // a missing Activity tab. Observed exactly that on 2026-08-13: 2.1a passed and
    // 2.1b died in navigateToTopUp() because the page was never attached.
    // The CLOCK also has to be at or after the account's own date, not just the
    // session restored. If it is behind, the reused account's subscription does
    // not exist yet and the top-up silently records nothing — no
    // subscription_topup row, no balance change, no notification — surfacing as
    // an empty Top Up history table. Observed on 2026-08-13, when the
    // jasecCcpBaseline auto-fixture was rewinding the clock before every test.
    // That specific cause is gone (this describe now opts out with
    // `ccpBaseline: null`), but the guard stays: the clock is tenant-global, so
    // another session or an earlier project in the same run can still move it.
    const storedDate = sharedAccount.ccpDate.slice(0, 10);
    const nowCcp = (await f.serverHelper.getCcpTime()).slice(0, 10);
    if (nowCcp < storedDate) {
      f.testLogger.log(`CCP was rewound to ${nowCcp}; restoring to ${storedDate} (the account's own date)`);
      await f.serverHelper.setAndVerifyCcpTime(storedDate);
    }

    f.testLogger.log(`reusing account ${sharedAccount.accountId} — re-attaching this page to Self Care`);
    await attachToAccountInSelfCare(f, sharedAccount.accountId);
    return sharedAccount;
  }

  const today = new Date().toISOString().slice(0, 10);
  const currentCcp = (await f.serverHelper.getCcpTime()).slice(0, 10);
  if (currentCcp < today) {
    await f.serverHelper.setAndVerifyCcpTime(today);
  } else {
    f.testLogger.log(
      `CCP already at ${currentCcp}, at or ahead of today (${today}) — leaving it alone ` +
      `rather than rewinding the shared clock.`,
    );
  }

  // Route this account's correspondence to the monitored mailbox. The shared
  // data row points at a real person, who must not be spammed by every run.
  const row: PrepaidAccountWithOrderRow = JSON.parse(JSON.stringify(baseRow));
  row.contact.email = EmailHelper.recipient();

  // `row` carries the REWRITTEN contact.email above, and both setup paths honour
  // it -- the gateway path reads row.contact.email rather than hardcoding one, so
  // the confirmation email still lands in the monitored mailbox.
  const accountId = await setUpAccountForTopUp({
    page: f.page, testLogger: f.testLogger,
    accountOrderApiHelper: f.accountOrderApiHelper,
    searchAccountsPage: f.searchAccountsPage, createAccountPage: f.createAccountPage,
    orderManagementPage: f.orderManagementPage, screenshotHelper: f.screenshotHelper,
    selfcareLoginPage: f.selfcareLoginPage,
    selfcareAccountSearchPage: f.selfcareAccountSearchPage,
  }, row);

  const ccpDate = await f.serverHelper.getCcpTime();
  sharedAccount = { accountId, row, ccpDate };
  return sharedAccount;
}

/**
 * Wait for the channel's confirmation email, then assert every template field.
 *
 * Shared by both channels because the EXPECTED CONTENT is identical — only the
 * `ID Transacción` format differs, and that is asserted separately against
 * `channel.ref` so a channel silently writing the other one's reference fails
 * here rather than passing the template's deliberately permissive check.
 *
 * The email is matched on the channel's REFERENCE, not just the account id: both
 * channels produce the same subject and both bodies carry the same account, so
 * matching on account alone would let 2.1b assert against 2.1a's message.
 */
async function verifyTopUpEmail(a: {
  channel: (typeof CHANNELS)[keyof typeof CHANNELS];
  accountId: string; row: PrepaidAccountWithOrderRow; ccpDate: string;
  balanceAfter: number; triggeredAt: Date;
  testInfo: any; testLogger: any; emailHelper: any; dbHelper: any;
}): Promise<void> {
  const { channel, accountId, row, ccpDate, balanceAfter, triggeredAt } = a;
  const refPattern = channel.ref(accountId);

  let email: ParsedEmail | null = null;
  let waitedMs = 0;
  let deliveredOverImap = false;

  // IMAP proves DELIVERY, but the stored row proves the BODY — content is written
  // before the SMTP send. A mailbox visibility lag must not cost the content
  // check, so a timeout degrades to the DB instead of aborting the test.
  try {
    const got = await a.emailHelper.waitForEmail({
      since: triggeredAt,
      // Narrows the IMAP SEARCH server-side. Without it the scan walks every
      // message from the whole day (SINCE is date-granular) and cannot finish
      // inside the wait budget on a busy run day.
      subjectContains: 'Recarga',
      description: `${channel.case} Top-Up Confirmation (${channel.label}) for ${accountId}`,
      match: (c: ParsedEmail) =>
        c.subject.includes('Recarga')
        && c.contains(accountId)
        && refPattern.test((c.field('ID Transacción') || '').trim()),
    });
    email = got.email;
    waitedMs = got.waitedMs;
    deliveredOverImap = true;
    a.testLogger.log(`${channel.case} delivered over IMAP in ${Math.round(waitedMs / 1000)}s`);
  } catch (err) {
    a.testLogger.log(`IMAP did not surface the ${channel.case} email in time: ${String(err)}`);
  }

  if (!email) {
    const notifyDb = new NotificationDbHelper(a.dbHelper, a.testLogger);
    const stored = await notifyDb.getRenderedEmail(accountId, 'BALANCE_TOPUP');
    expect(
      stored,
      `${channel.case} — no email arrived AND no email_notification row exists for `
      + `${accountId}. The engine never produced the notification for the `
      + `${channel.label} channel, which is a product defect, not a delivery lag.`,
    ).toBeTruthy();

    email = stored!.email;
    a.testLogger.log(
      `falling back to ${stored!.row.id} (status ${stored!.row.status}) — `
      + `content asserted against the stored body`,
    );

    if (stored!.row.status === 'FAILED') {
      expect
        .soft(
          stored!.row.status,
          `${channel.case} delivery — ${accountId}: rendered but SMTP refused it `
          + `(${stored!.row.id} FAILED). That is case 9.1, not a template problem.`,
        )
        .toBe('SUCCESS');
    } else {
      a.testInfo.annotations.push({
        type: 'imap-lag',
        description:
          `${accountId}: ${stored!.row.id} is SUCCESS (rendered and accepted by SMTP) `
          + `but IMAP did not surface it within the wait. Delivery unobserved, content `
          + `asserted from the stored body.`,
      });
    }
  }

  await a.testInfo.attach(`topup-email-${channel.case}-${accountId}.html`, {
    body: email.html,
    contentType: 'text/html',
  }).catch(() => { });

  // Channel-specific. The template accepts any of the three reference formats, so
  // pin THIS channel's shape here.
  const renderedRef = (email.field('ID Transacción') || '').trim();
  expect
    .soft(
      refPattern.test(renderedRef),
      `${channel.case} ID Transacción — ${channel.label} must write `
      + `${channel.refShape(accountId)}\n  actual: "${renderedRef}"`,
    )
    .toBe(true);

  const ctx: NotificationContext = {
    accountId,
    firstName: row.contact.firstName,
    lastName: row.contact.lastName,
    recipient: row.contact.email,
    ccpDate,
    email,
    // Only meaningful when IMAP actually saw it; undefined otherwise so the report
    // does not claim instant delivery for a DB fallback.
    deliverySeconds: deliveredOverImap ? Math.round(waitedMs / 1000) : undefined,
    topUpAmount: TOP_UP_AMOUNT,
    balanceAfter,
    paymentSource: undefined, // falls back to the template's expected value
  };

  const reportHelper = new NotificationReportHelper(a.testLogger);
  const results = reportHelper.evaluateAll(topUpConfirmationTemplate, ctx);

  // One step per field so the HTML report mirrors the Jira table. Soft, so every
  // field is reported in a single run rather than stopping at the first failure.
  for (const result of results) {
    await test.step(`${channel.case} ${result.row}`, async () => {
      if (result.knownDefect) {
        a.testLogger.log(
          `${result.row} — ${result.passed ? 'passed' : 'failed as expected'} `
          + `(known defect: ${result.knownDefect}). Not failing the run.`,
        );
        return;
      }
      expect
        .soft(
          result.passed,
          `${result.row}\n  expected: ${result.expected}\n  actual:   ${result.actual}`,
        )
        .toBeTruthy();
    });
  }

  const markdown = reportHelper.buildJiraTable(topUpConfirmationTemplate, ctx, results);
  const reportPath = reportHelper.writeReport(topUpConfirmationTemplate, ctx, markdown);
  await a.testInfo
    .attach(`${topUpConfirmationTemplate.ticket}-${channel.case}-qa-table`, {
      path: reportPath,
      contentType: 'text/markdown',
    })
    .catch(() => { });

  a.testLogger.log(`\n${markdown}\n`);
  console.log(`\n${markdown}\n`);

  const unexpected = NotificationReportHelper.unexpectedFailures(results);
  const known = NotificationReportHelper.knownFailures(results);
  a.testLogger.log(
    `${channel.case} (${channel.label}) — account ${accountId}: ${results.length} fields `
    + `checked, ${unexpected.length} unexpected failure(s), ${known.length} known defect(s).`,
  );

  expect(
    unexpected.map((f) => f.row),
    `${channel.case} — fields failing outside the known-defect list`,
  ).toEqual([]);
}

test.describe(
  'TS-01 — Notifications',
  { tag: ['@regression', '@jasec', '@notification', '@ts-01'] },
  () => {
    // Serial: 2.1b reuses the account 2.1a created. If 2.1a fails, 2.1b is
    // skipped rather than running against half-built state.
    test.describe.configure({ mode: 'serial' });

    // This spec sets the clock itself in BOTH branches of ensureAccount, so the
    // jasecCcpBaseline auto-reset was pure interference: it rewound the clock
    // immediately before each test and ensureAccount had to detect and undo it.
    test.use({ ccpBaseline: null });

    /**
     * The global 600s budget is not enough for this spec and never was.
     * Measured 2026-08-13: Self Care account creation alone is ~3m15s, then card
     * tokenization, the top-up, and the email wait. The run hit the 10-minute
     * timeout mid-wait, Playwright tore the fixtures down underneath the
     * in-flight IMAP scan, and the failure surfaced as "Connection not available"
     * followed by a use-after-close on the DB pool — neither of which was the real
     * problem. 2.1b then reuses the account, so it needs far less.
     */
    test.setTimeout(20 * 60 * 1000);

    test(
      '2.1a: Top-Up Confirmation email — Pay Now (saved card), TU- reference',
      { tag: ['@tc-2-1a', '@jepyp-49'] },
      async ({
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
        serverHelper, dbHelper, emailHelper,
      }, testInfo) => {
        const { accountId, row, ccpDate } = await ensureAccount({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage, serverHelper,
        });

        const balanceBefore = await dbHelper.getAccountBalance(accountId);
        testLogger.data('Balance before top-up', balanceBefore);

        // Save a card first — Pay Now charges the token, so without this it has
        // nothing to charge and no-ops.
        await selfcareActivityPage.navigateToManagePaymentProfile();
        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.completeTokenization('approve');
        await selfcareActivityPage.assertCardOnFilePopulated();

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        // Reload so the Top Up view's Card On File section picks up the token
        // just saved — without this the view renders CVV/Token/Expiry empty and
        // Pay Now silently no-ops (same trap as top-up TS-02 TC 2.2).
        await selfcareTopupPage.reload(selfcareActivityPage);

        const triggeredAt = new Date();
        await selfcareTopupPage.enterAmount(TOP_UP_AMOUNT);
        await selfcareTopupPage.clickPayNow();
        await selfcareTopupPage.assertPaymentSuccess();

        const balanceAfter = await dbHelper.assertTopUpApplied(
          accountId, TOP_UP_AMOUNT, balanceBefore,
        );

        await verifyTopUpEmail({
          channel: CHANNELS.payNow, accountId, row, ccpDate, balanceAfter,
          triggeredAt, testInfo, testLogger, emailHelper, dbHelper,
        });
      },
    );

    test(
      '2.1b: Top-Up Confirmation email — Pay with PlaceToPay, TOPUP- reference',
      { tag: ['@tc-2-1b', '@jepyp-49'] },
      async ({
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
        serverHelper, dbHelper, emailHelper,
      }, testInfo) => {
        const { accountId, row, ccpDate } = await ensureAccount({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage, serverHelper,
        });

        const balanceBefore = await dbHelper.getAccountBalance(accountId);
        testLogger.data('Balance before top-up', balanceBefore);

        // No card needed: PlaceToPay collects the card during checkout, which is
        // why this channel works on accounts with an empty Card On File panel.
        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();

        const triggeredAt = new Date();
        await selfcareTopupPage.enterAmount(TOP_UP_AMOUNT);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');
        // Returning from the external checkout leaves the view stale — reload
        // before asserting, same as top-up TS-02 TC 2.3a.
        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertPaymentSuccess();

        const balanceAfter = await dbHelper.assertTopUpApplied(
          accountId, TOP_UP_AMOUNT, balanceBefore,
        );

        await verifyTopUpEmail({
          channel: CHANNELS.placeToPay, accountId, row, ccpDate, balanceAfter,
          triggeredAt, testInfo, testLogger, emailHelper, dbHelper,
        });
      },
    );
  },
);
