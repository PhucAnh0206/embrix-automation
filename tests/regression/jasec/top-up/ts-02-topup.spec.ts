/**
 * TS-02 — Top-Up
 *
 * Tests (in execution order):
 *   2.1  Top-Up history date range — history clears at month rollover
 *   2.2  Top Up using Pay Now (saved-card token, no PTP redirect)
 *   2.3a Top Up using Pay with PlaceToPay — APPROVE card
 *   2.3b Top Up using Pay with PlaceToPay — DECLINE card
 *   2.4  Rapid double-click Pay Now — frontend idempotency        
 *   2.5  Duplicate transaction blocked — same-reference idempotency 
 *   2.6  Receipt column visible when feature flag on             
 *   2.7  Receipt column header localized (Receipt / Recibo)      
 *   2.8  View / Download Receipt opens PDF in new tab             
 *   2.9  Re-clicking Receipt returns the same cached PDF         
 *   2.10 Receipt PDF contains required fields                     
 *
 * Account-setup strategy:
 *   • Group A — SHARED account (2.2, 2.3a, 2.6, 2.7, 2.8). The first Group
 *     A test to run creates ONE account with saved card + one seed top-up
 *     (~4 min); the remaining Group A tests attach a fresh page to that
 *     same account (~20 sec each). Saves ~10 min per full-suite run.
 *     Running any single Group A test independently still works — the
 *     `ensureSharedAccountAndAttach` helper bootstraps state on demand.
 *   • Group B — ISOLATED (2.1, 2.3b, 2.4, 2.5, 2.9, 2.10). Each creates
 *     its own fresh account because it needs a controlled initial state
 *     (empty history, exact row counts, ccpTime-driven dates, or — for
 *     TC 2.9 — a stable single-row history so `nth(0)` refers to the
 *     same top-up on both clicks).
 *
 * TC 2.6–2.10 require the Self Care `topupReceiptsEnabled` feature flag to be
 * on. It isn't readable at runtime, so it's declared via the
 * TOPUP_RECEIPTS_ENABLED env var — set it to `false` on an environment
 * without the feature and those five tests skip instead of failing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { LONG_WAIT } from '../../../../helpers/timeouts.helper';
import { fetchAndExtractPdfText } from '../../../../helpers/pdf.helper';
import {
  setUpAccountInSelfCare,
  attachToAccountInSelfCare,
  type PrepaidAccountWithOrderRow,
} from '../../../../fixtures/create-prepaid-account.helper';

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const dataRows: PrepaidAccountWithOrderRow[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const baseRow = dataRows[0];

/**
 * TC 2.6-2.10 exercise the Top-Up receipt feature, which is behind the
 * `topupReceiptsEnabled` flag on the Self Care frontend. The flag is not
 * exposed via GraphQL, so it cannot be probed at runtime — it has to be
 * declared here.
 *
 * Defaults to enabled, matching every environment where these tests were
 * written. Set TOPUP_RECEIPTS_ENABLED=false in .env when running against an
 * environment that has the feature off, so the five receipt tests SKIP with a
 * clear reason instead of failing on missing Receipt columns and buttons —
 * which reads like a product defect but isn't.
 */
const RECEIPTS_ENABLED =
  (process.env.TOPUP_RECEIPTS_ENABLED ?? 'true').trim().toLowerCase() !== 'false';

const RECEIPTS_SKIP_REASON =
  'Top-Up receipts are disabled on this environment (TOPUP_RECEIPTS_ENABLED=false)';

// ── Shared-account plumbing for Group A (2.2, 2.3a, 2.6, 2.7, 2.8) ─────
// Module-level cache. First Group A test to run does the full setup and
// stores the accountId; subsequent Group A tests attach a fresh page to
// the cached accountId. Running one test in isolation still works —
// `sharedAccountId` is null at file-load time, so whichever test fires
// first triggers the setup.
let sharedAccountId: string | null = null;

async function ensureSharedAccountAndAttach(fixtures: Parameters<typeof setUpAccountInSelfCare>[0] & {
  selfcareActivityPage: import('../../../../pages/selfcare/selfcare-activity.page').SelfcareActivityPage;
  selfcareTopupPage: import('../../../../pages/selfcare/selfcare-topup.page').SelfcareTopupPage;
  placeToPayCheckoutPage: import('../../../../pages/selfcare/placetopay-checkout.page').PlaceToPayCheckoutPage;
}): Promise<string> {
  const {
    selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
    testLogger,
  } = fixtures;

  if (sharedAccountId !== null) {
    testLogger.log(`Reusing shared account ${sharedAccountId}`);
    await attachToAccountInSelfCare(fixtures, sharedAccountId);
    return sharedAccountId;
  }

  testLogger.log('Creating shared Group A account (first shared test in this run)');
  const accountId = await setUpAccountInSelfCare(fixtures, baseRow);

  // Save a card so downstream Pay Now tests have a token.
  await selfcareActivityPage.navigateToManagePaymentProfile();
  await selfcareActivityPage.clickSaveWithPlaceToPay();
  await placeToPayCheckoutPage.completeTokenization('approve');
  await selfcareActivityPage.assertCardOnFilePopulated();

  // Seed one top-up so receipt tests have a history row to click.
  await selfcareActivityPage.navigateToTopUp();
  await selfcareTopupPage.assertLoaded();
  await selfcareTopupPage.reload(selfcareActivityPage);
  await selfcareTopupPage.enterAmount(5000);
  await selfcareTopupPage.clickPayNow();
  await selfcareTopupPage.assertPaymentSuccess();

  sharedAccountId = accountId;
  return accountId;
}

test.describe(
  'TS-02 — Top-Up',
  { tag: ['@regression', '@jasec', '@top-up', '@ts-02'] },
  () => {
    // ── TC 2.1 — History date range ───────────────────────────────────
    test(
      '2.1: Top-Up history table only shows current-period entries',
      { tag: ['@tc-2-1'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
        serverHelper,
      }) => {
        const monthA = '2026-07-15';
        const monthB = '2026-08-15';

        await serverHelper.setAndVerifyCcpTime(monthA);

        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        // Top up in month A.
        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();

        const topUp = 500;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');

        // Hard reload after returning from PlaceToPay — otherwise the Top Up
        // view may serve a cached empty-history state and the freshly-posted
        // row isn't visible for LONG_WAIT.
        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertPaymentSuccess();
        await selfcareTopupPage.assertHistoryRowCountAtLeast(1);

        // Advance to month B; history should be empty. Reload so the Top Up
        // view fetches the new-month state (the view doesn't auto-refresh).
        await serverHelper.setAndVerifyCcpTime(monthB);
        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertHistoryEmpty();

        testLogger.log(`✓ TC 2.1 — account ${accountId}: history scoped to current period`);
      },
    );

    // ── TC 2.2 — Pay Now (saved card, no PTP redirect) [GROUP A: shared] ──
    test(
      '2.2: Top Up using Pay Now with a saved card',
      { tag: ['@tc-2-2'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await ensureSharedAccountAndAttach({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
          selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
        });

        // Shared account already has a saved card — go straight to Top Up.
        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.reload(selfcareActivityPage);

        const topUp = 5000;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayNow();
        await selfcareTopupPage.assertPaymentSuccess();

        testLogger.log(`✓ TC 2.2 — account ${accountId} topped up ${topUp} CRC via saved card`);
      },
    );

    // ── TC 2.3a — Pay with PlaceToPay (APPROVE) [GROUP A: shared] ─────
    test(
      '2.3a: Top Up using Pay with PlaceToPay — APPROVE card',
      { tag: ['@tc-2-3', '@tc-2-3a'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await ensureSharedAccountAndAttach({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
          selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
        });

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();

        const topUp = 500;

        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('approve');

        // Hard reload after returning from PlaceToPay — otherwise the Top Up
        // view may serve a cached history state and the freshly-posted row
        // isn't visible for LONG_WAIT.
        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertPaymentSuccess();

        testLogger.log(`✓ TC 2.3a — account ${accountId} topped up ${topUp} CRC (approved)`);
      },
    );

    // ── TC 2.3b — Pay with PlaceToPay (DECLINE) ───────────────────────
    test(
      '2.3b: Top Up using Pay with PlaceToPay — DECLINE card, no top-up recorded',
      { tag: ['@tc-2-3', '@tc-2-3b'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.enterAmount(500);
        await selfcareTopupPage.clickPayWithPlaceToPay();
        await placeToPayCheckoutPage.completePaymentFlow('deny');

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertHistoryEmpty();

        testLogger.log(`✓ TC 2.3b — account ${accountId}: declined payment not recorded`);
      },
    );

    // TC 2.4 — Rapid double-click Pay Now (frontend idempotency, spec TC 3.4)
    test(
      '2.4: Rapid double-click Pay Now — only one top-up recorded (frontend idempotency)',
      { tag: ['@tc-2-4'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToManagePaymentProfile();
        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.completeTokenization('approve');
        await selfcareActivityPage.assertCardOnFilePopulated();

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.reload(selfcareActivityPage);

        let topUpRequestCount = 0;
        page.on('request', (req) => {
          if (req.url().includes('/prepaidTopUp') && req.method() === 'POST') {
            topUpRequestCount++;
          }
        });

        const topUp = 100;
        await selfcareTopupPage.enterAmount(topUp);
        await selfcareTopupPage.rapidClickPayNow(3);
        await selfcareTopupPage.assertPaymentSuccess();

        expect(topUpRequestCount).toBe(1);
        await selfcareTopupPage.assertHistoryRowCountEquals(1);
        await selfcareTopupPage.assertAmountInputCleared();

        testLogger.log(
          `✓ TC 2.4 — account ${accountId}: 3 rapid clicks produced ${topUpRequestCount} request, ` +
          `1 history row, amount input cleared`,
        );
      },
    );

    // TC 2.5 — Backend idempotency via the `reference` key (spec TC 3.5).
    //
    // Two identical top-up POSTs are fired in parallel with the same
    // `reference`. The backend dedupes on that field, enforced by the unique
    // constraint `ux_subscription_topup_acct_payref` on
    // (accountId, paymentrefid), so exactly one must succeed and the other
    // must be rejected — and only one top-up may reach the account.
    //
    // Asserts:
    //   • exactly one SUCCESS and one non-SUCCESS response
    //   • the rejection exposes no SQL or constraint internals
    //   • the history table shows exactly one row
    //
    // Caveats:
    //   • Rejection may take ANY non-SUCCESS form; the response carries
    //     `status: "FAILED"` rather than a semantic duplicate code. The
    //     `DUPLICATE_TRANSACTION` status belongs to the payment gateway's
    //     `/transaction/capture` endpoint, which is outside TS-02's scope.
    //   • `reference` is optional on the API, so its absence is not an
    //     error — omitting it simply skips dedup. The frontend always sends
    //     `TU-<accountId>-<hex>`; any UUID works here.
    //   • This posts directly to the CRM gateway, bypassing the UI, so it
    //     depends on CRM_GATEWAY_URL pointing at the same environment the
    //     UI assertions read.
    test(
      '2.5: Duplicate transaction blocked — parallel POSTs with same reference UUID (backend idempotency)',
      { tag: ['@tc-2-5'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToManagePaymentProfile();
        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.completeTokenization('approve');
        await selfcareActivityPage.assertCardOnFilePopulated();

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.reload(selfcareActivityPage);

        // No default: a hardcoded fallback would POST at one environment
        // while the UI assertions below read another, producing a false
        // "dedup is broken" failure. Fail loudly instead.
        const crmGatewayUrl = process.env.CRM_GATEWAY_URL;
        if (!crmGatewayUrl) {
          throw new Error(
            'CRM_GATEWAY_URL is not set. TC 2.5 posts directly to the CRM gateway and '
            + 'must target the same environment as the UI under test — set it in .env '
            + '(playwright.config.ts derives it from TEST_ENV for known environments).',
          );
        }
        const url = `${crmGatewayUrl}/prepaidTopUp`;
        const topUp = 75;
        const reference = crypto.randomUUID();
        const body = {
          accountId,
          amount: topUp,
          paymentDescription: `Embrix Top Up ${topUp}`,
          paymentSource: 'CREDIT_CARD',
          serviceType: 'ELECTRICITY',
          reference,
        };

        testLogger.data('Duplicate-test payload (both requests use same reference)', body);

        const [resp1, resp2] = await Promise.all([
          page.request.post(url, { data: body }),
          page.request.post(url, { data: body }),
        ]);
        const [json1, json2] = await Promise.all([resp1.json(), resp2.json()]);
        testLogger.data('Duplicate top-up responses', { request1: json1, request2: json2 });

        const statuses = [json1.status, json2.status];
        const successes = statuses.filter((s) => s === 'SUCCESS').length;
        const rejections = statuses.filter((s) => s !== 'SUCCESS').length;

        // ── Dedup must work ───────────────────────────────────────────
        // Both returning SUCCESS means dedup is broken and the account was
        // charged twice.
        expect(successes, `expected exactly 1 SUCCESS, got statuses=${JSON.stringify(statuses)}`).toBe(1);
        expect(rejections, `expected exactly 1 non-SUCCESS rejection, got statuses=${JSON.stringify(statuses)}`).toBe(1);

        // ── Clean error surface ───────────────────────────────────────
        // The rejection must surface as an application error, not a raw
        // PostgreSQL exception bubbling up from the constraint.
        const combinedErrorMsg = `${json1.errorMsg ?? ''} ${json2.errorMsg ?? ''}`;
        expect(
          combinedErrorMsg,
          'response should NOT leak raw PostgreSQL exception details (constraint names, column names, SQL text)',
        ).not.toMatch(/PSQLException|duplicate\s+key\s+value|unique\s+constraint|ux_[a-z_]+/i);

        // Confirm the DUPLICATE actually blocked the second write: reload UI,
        // history table should have exactly one top-up row (not two).
        await selfcareTopupPage.reload(selfcareActivityPage);
        await selfcareTopupPage.assertHistoryRowCountEquals(1);

        testLogger.log(`✓ TC 2.5 — account ${accountId}: same-reference duplicate rejected (reference=${reference})`);
      },
    );

    // TC 2.6 — Receipt column visible when feature flag is on [GROUP A: shared]
    test(
      '2.6: Receipt column visible on Top Up history when feature flag is on',
      { tag: ['@tc-2-6'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        test.skip(!RECEIPTS_ENABLED, RECEIPTS_SKIP_REASON);

        const accountId = await ensureSharedAccountAndAttach({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
          selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
        });

        // Shared account already has a seed top-up — go directly to Top Up
        // and verify the column + button are rendered on the existing row.
        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.reload(selfcareActivityPage);

        await selfcareTopupPage.assertReceiptColumnVisible('en');
        await expect(
          page.getByRole('button', { name: /View\s*\/\s*Download\s*Receipt/i }).first(),
        ).toBeVisible({ timeout: LONG_WAIT });

        testLogger.log(`✓ TC 2.6 — account ${accountId}: Receipt column + button visible`);
      },
    );

    // TC 2.7 — Column header localized [GROUP A: shared]
    test(
      '2.7: Receipt column header localized (Receipt in EN, Recibo in ES)',
      { tag: ['@tc-2-7'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        test.skip(!RECEIPTS_ENABLED, RECEIPTS_SKIP_REASON);

        const accountId = await ensureSharedAccountAndAttach({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
          selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
        });

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.reload(selfcareActivityPage);

        await selfcareTopupPage.assertReceiptColumnVisible('en');
        await expect(
          page.getByRole('button', { name: /View\s*\/\s*Download\s*Receipt/i }).first(),
        ).toBeVisible({ timeout: LONG_WAIT });

        await selfcareTopupPage.switchLanguageTo('es');
        await selfcareTopupPage.assertReceiptColumnVisible('es');
        await expect(
          page.getByRole('button', { name: /Ver\s*\/\s*Descargar\s*recibo/i }).first(),
        ).toBeVisible({ timeout: LONG_WAIT });

        // Restore English so downstream Group A tests aren't surprised by
        // Spanish labels/buttons on the shared account's next attach.
        await selfcareTopupPage.switchLanguageTo('en');

        testLogger.log(`✓ TC 2.7 — account ${accountId}: header + button i18n verified`);
      },
    );

    // TC 2.8 — Generate receipt [GROUP A: shared]
    test(
      '2.8: View / Download Receipt opens PDF in a new tab',
      { tag: ['@tc-2-8'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        test.skip(!RECEIPTS_ENABLED, RECEIPTS_SKIP_REASON);

        const accountId = await ensureSharedAccountAndAttach({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
          selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
        });

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.reload(selfcareActivityPage);

        const receiptUrl = await selfcareTopupPage.clickReceiptButtonForRow(0);
        testLogger.data('Receipt PDF URL', receiptUrl);

        expect(receiptUrl).toMatch(/\.pdf|receipts|topups|amazonaws/i);

        testLogger.log(`✓ TC 2.8 — account ${accountId}: receipt PDF served at ${receiptUrl}`);
      },
    );

    // TC 2.9 — Cached re-download [GROUP B: ISOLATED]
    //
    // Clicking the same history row twice must return the same PDF: the S3
    // key is `{topupId}_{uuid}.pdf`, so a stable UUID across both fetches
    // proves the receipt was cached rather than regenerated.
    //
    // Caveat: needs its own account. The assertion pins row 0, which only
    // refers to the same top-up on both clicks when history holds exactly
    // one row. On the Group A shared account other tests' top-ups
    // accumulate, and async propagation can shift which one sits at row 0
    // between the two clicks.
    test(
      '2.9: Re-clicking View / Download Receipt returns the same cached PDF',
      { tag: ['@tc-2-9'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        test.skip(!RECEIPTS_ENABLED, RECEIPTS_SKIP_REASON);

        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToManagePaymentProfile();
        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.completeTokenization('approve');
        await selfcareActivityPage.assertCardOnFilePopulated();

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.reload(selfcareActivityPage);

        await selfcareTopupPage.enterAmount(100);
        await selfcareTopupPage.clickPayNow();
        await selfcareTopupPage.assertPaymentSuccess();

        // Deterministic key: {topupId}_{uuid}.pdf — the UUID must be the same
        // on both fetches for the same top-up (S3 cache key stability).
        const uuidPattern = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

        const firstUrl = await selfcareTopupPage.clickReceiptButtonForRow(0);
        const firstUuid = firstUrl.match(uuidPattern)?.[0];

        const secondUrl = await selfcareTopupPage.clickReceiptButtonForRow(0);
        const secondUuid = secondUrl.match(uuidPattern)?.[0];

        testLogger.data('Receipt URLs (should share UUID)', { firstUrl, secondUrl, firstUuid, secondUuid });

        expect(firstUuid, 'first receipt URL should contain a UUID').toBeDefined();
        expect(secondUuid).toBe(firstUuid);

        testLogger.log(`✓ TC 2.9 — account ${accountId}: same cached receipt (uuid ${firstUuid})`);
      },
    );

    // TC 2.10 — Receipt PDF content (Comprobante de Recarga)
    //
    // Extracts the PDF's text and checks each required field by regex against
    // values fixed during setup: the top-up amount, the frozen ccpTime date,
    // and the account id.
    //
    // Caveats:
    //   • The PDF renders in Spanish regardless of the UI language toggle, so
    //     assertions target Spanish labels.
    //   • Field checks are soft so one run reports every missing field rather
    //     than stopping at the first. The two structural checks — extractable
    //     text, and the document title — stay hard, since a broken PDF makes
    //     the field results meaningless.
    //   • The clock is frozen first so the printed date is deterministic.
    test(
      '2.10: Receipt PDF contains required fields (Company, Customer, Meter ID, Amount+Currency, Date, Transaction ID)',
      { tag: ['@tc-2-10'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
        serverHelper,
      }) => {
        test.skip(!RECEIPTS_ENABLED, RECEIPTS_SKIP_REASON);

        // Freeze the clock so the PDF date is deterministic.
        const testDate = '2026-07-15';
        await serverHelper.setAndVerifyCcpTime(testDate);

        const accountId = await setUpAccountInSelfCare({
          page, testLogger, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        await selfcareActivityPage.navigateToManagePaymentProfile();
        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.completeTokenization('approve');
        await selfcareActivityPage.assertCardOnFilePopulated();

        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertLoaded();
        await selfcareTopupPage.reload(selfcareActivityPage);

        const topUpAmount = 5000;
        await selfcareTopupPage.enterAmount(topUpAmount);
        await selfcareTopupPage.clickPayNow();
        await selfcareTopupPage.assertPaymentSuccess();

        const receiptUrl = await selfcareTopupPage.clickReceiptButtonForRow(0);
        const text = await fetchAndExtractPdfText(receiptUrl);

        testLogger.data('Extracted PDF text', text);

        // ── Structural / template sanity (hard — abort if PDF is broken) ─
        expect(text.length, 'PDF has extractable text').toBeGreaterThan(50);
        expect(text, 'title "Comprobante de Recarga"').toMatch(/Comprobante\s+de\s+Recarga/i);

        // ── Field-level checks (soft — surface every gap in one run) ──
        //
        // Company Name: JASEC
        expect.soft(text, 'Compañía: JASEC').toMatch(/Compa[ñn]ía\s*:?\s*JASEC/i);

        // Customer Name — label + non-empty value (no exact coupling to
        // the setup-generated name).
        expect.soft(text, 'Nombre del Cliente label with non-empty value')
          .toMatch(/Nombre\s+del\s+Cliente[\.\s:]*[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ\s]{1,}/i);

        // Meter ID — regex requires the "Medidor" label followed by a
        // non-empty value (\S+). Catches "label present but value blank".
        expect.soft(text, 'Meter ID (Medidor) present in PDF with non-empty value')
          .toMatch(/Medidor[\.\s:]*\S+/i);

        // Amount — accepts 5000, 5000.00, 5,000, 5.000 for locale flex.
        expect.soft(text, `Monto de Recarga contains ${topUpAmount}`)
          .toMatch(new RegExp(`Monto\\s+de\\s+Recarga[\\.\\s:]*\\D*${topUpAmount}([.,]\\d{2})?`, 'i'));

        // Currency unit — structural check: any JASEC-configured currency (CRC / CAD / USD)
        // within 60 chars after "Monto" label. Symbol variants accepted for
        // CRC (₡) and USD ($) — CAD has no distinct symbol in these PDFs.
        expect.soft(text, 'A currency unit is displayed alongside amount')
          .toMatch(/Monto[\s\S]{0,60}(?:CRC|CAD|USD|₡|\$)/i);

        // Business-rule check: JASEC operates in Costa Rica — receipts
        // must be CRC. If CAD or USD ever appears on a JASEC receipt,
        // this fires separately from the structural check above so we can
        // tell "currency missing" vs "currency wrong."
        expect.soft(text, 'Currency is CRC (JASEC = Costa Rica)')
          .toMatch(/CRC|₡/);

        // Date — ccpTime is frozen; PDF sample renders ISO. Accept ISO or
        // DD/MM/YYYY / DD-MM-YYYY as safety.
        const isoDate = testDate;
        const [yyyy, mm, dd] = testDate.split('-');
        const altDate = `${dd}[\\/-]${mm}[\\/-]${yyyy}`;
        expect.soft(text, `Fecha: ${testDate}`)
          .toMatch(new RegExp(`(${isoDate}|${altDate})`));

        // Transaction ID — format TU-<accountId>-<hex>, e.g. TU-ACT-100468-caf01a26dd98
        expect.soft(text, 'ID de Transacción with TU- prefix and account id')
          .toMatch(new RegExp(`ID\\s+de\\s+Transacci[oó]n[\\.\\s:]*TU[-_]${accountId}[-_][a-f0-9]+`, 'i'));

        testLogger.log(`✓ TC 2.10 assertions dispatched — account ${accountId}, amount ${topUpAmount}, date ${testDate}`);
      },
    );

  },
);
