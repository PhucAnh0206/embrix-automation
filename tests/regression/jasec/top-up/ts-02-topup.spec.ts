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
 *   • Group A — SHARED account (2.2, 2.3a, 2.6, 2.7, 2.8). The first Group A
 *     test to run creates ONE account with a saved card and one seed top-up;
 *     the rest attach a fresh page to it. Measured on the 2026-08-20 run:
 *     205s for the creating test vs 61-70s for each attaching one, so the
 *     sharing is worth roughly 7 minutes across the group. Running a single
 *     Group A test on its own still works — whichever runs first creates.
 *     Caveat: the cache is per WORKER, so a failure anywhere in the file
 *     restarts the worker and the next Group A test pays full price again.
 *     See fixtures/shared-account.helper.ts.
 *   • Group B — ISOLATED (2.1, 2.3b, 2.4, 2.5, 2.9, 2.10). Each creates
 *     its own fresh account because it needs a controlled initial state
 *     (empty history, exact row counts, ccpTime-driven dates, or — for
 *     TC 2.9 — a stable single-row history so `nth(0)` refers to the
 *     same top-up on both clicks). These are the remaining runtime cost of
 *     this file and cannot be shared without weakening the assertions.
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
  setUpAccountForTopUp,
  attachToAccountInSelfCare,
  createPrepaidAccountOnly,
  createPrepaidAccountViaGateway,
  type PrepaidAccountWithOrderRow,
} from '../../../../fixtures/create-prepaid-account.helper';
import { SharedAccount } from '../../../../fixtures/shared-account.helper';
import type { SelfcareActivityPage } from '../../../../pages/selfcare/selfcare-activity.page';
import type { SelfcareTopupPage } from '../../../../pages/selfcare/selfcare-topup.page';
import type {
  PlaceToPayCheckoutPage,
  PlaceToPayCardVariant,
} from '../../../../pages/selfcare/placetopay-checkout.page';
import type { Page, Response } from '@playwright/test';
import type { TestLogger } from '../../../../helpers/test-logger';
import type { DbHelper } from '../../../../helpers/db.helper';
import type { SelfcareLoginPage } from '../../../../pages/selfcare/selfcare-login.page';
import type { SelfcareAccountSearchPage } from '../../../../pages/selfcare/selfcare-account-search.page';

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
// Backed by the shared SharedAccount helper rather than a bespoke module-level
// cache, so this file and the notification TS-01 suite — which had grown two
// slightly different copies of the same idea — now share one implementation and
// one set of documented caveats (see fixtures/shared-account.helper.ts).
type GroupAFixtures = Parameters<typeof setUpAccountForTopUp>[0] & {
  selfcareActivityPage: SelfcareActivityPage;
  selfcareTopupPage: SelfcareTopupPage;
  placeToPayCheckoutPage: PlaceToPayCheckoutPage;
};

const groupAAccount = new SharedAccount<GroupAFixtures>({
  label: 'TS-02 Group A',
  create: async (fixtures) => {
    const { selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage } = fixtures;
    const accountId = await setUpAccountForTopUp(fixtures, baseRow);

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
      // Pass the activity page so this RE-FETCHES between attempts. The history
      // table is filled on page load, so a row that lands after the render never
      // appears by waiting. That failed this very setup on 2026-08-28 and took the
      // whole file with it, since every case here needs the shared account to exist.
      await selfcareTopupPage.assertPaymentSuccess(selfcareActivityPage);

    return accountId;
  },
  attach: (fixtures, accountId) => attachToAccountInSelfCare(fixtures, accountId),
});

const ensureSharedAccountAndAttach = (fixtures: GroupAFixtures): Promise<string> =>
  groupAAccount.ensure(fixtures);

test.describe(
  'TS-02 — Top-Up',
  { tag: ['@regression', '@jasec', '@top-up', '@ts-02'] },
  () => {
    // ── TC 2.1 — History date range ───────────────────────────────────
    test(
      '2.1: Top-Up history table only shows current-period entries',
      { tag: ['@tc-2-1'] },
      async ({
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
        serverHelper,
      }) => {
        const monthA = '2026-07-15';
        const monthB = '2026-08-15';

        await serverHelper.setAndVerifyCcpTime(monthA);

        const accountId = await setUpAccountForTopUp({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
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
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await ensureSharedAccountAndAttach({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
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
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await ensureSharedAccountAndAttach({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
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
    //
    // Strengthened 2026-08-28. This used to end at assertHistoryEmpty(), which
    // left three holes:
    //
    //  - It never confirmed the gateway actually DECLINED. The day the deny test
    //    card starts being approved, "no history row" becomes the real defect and
    //    this case would have reported it as a pass.
    //  - It never checked the BALANCE. A declined charge that still credited the
    //    account would not show in the history table but would be money invented
    //    from nothing.
    //  - assertHistoryEmpty() reads the history table, which is filled by a fetch
    //    on page load - the same class of check that made the card-on-file
    //    assertion unreliable. It is kept, but it is no longer the only evidence.
    //
    // The verdict is now read off the wire. Captured 2026-08-28:
    //   deny -> /verify {"successful":false,"status":"REJECTED","resultCode":"05",
    //                    "message":"No honrar"}  and prepaidTopUp NOT CALLED.
    test(
      '2.3b: Top Up using Pay with PlaceToPay — DECLINE card, no top-up recorded',
      { tag: ['@tc-2-3', '@tc-2-3b'] },
      async ({
        page, testLogger, dbHelper, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        // Proving a negative needs the full 60s settle window inside the probe.
        test.setTimeout(600_000);

        const accountId = await setUpAccountForTopUp({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
          orderManagementPage, screenshotHelper,
          selfcareLoginPage, selfcareAccountSearchPage,
        }, baseRow);

        // 500 explicitly, as this case always used, rather than the account's
        // displayed minimum - a declined charge is declined at any amount, and
        // keeping the figure preserves what the case has always exercised.
        const probe = await probeTopUp(
          {
            page, testLogger, dbHelper,
            selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
          },
          accountId, '2.3b deny', 'deny', 500,
        );

        // 1. The gateway really declined - not merely "did not approve".
        expect(
          probe.chargeVerdict,
          `2.3b needs a genuine decline from the gateway for ${accountId}. ` +
          `Verdict was: ${probe.chargeVerdict}. If the deny test card is now being ` +
          `APPROVED, this case can no longer prove anything and the card data needs ` +
          `revisiting.`,
        ).toContain('REJECTED');

        expect(
          probe.charged,
          `${accountId}: the deny card was APPROVED [${probe.chargeVerdict}]`,
        ).toBe(false);

        // 2. Nothing registered, and the register call was never even made.
        expect(
          probe.registered,
          `${accountId}: a declined charge still wrote a subscription_topup row ` +
          `(${probe.topUpsBefore} -> ${probe.topUpsAfter})`,
        ).toBe(false);

        expect(
          probe.registerAcked,
          `${accountId}: prepaidTopUp was CALLED for a declined charge - it should ` +
          `not be reached at all. Calls: ${probe.calls.join(' | ')}`,
        ).toBeNull();

        // 3. Balance untouched, plus the charged/registered biconditional.
        assertChargeAndRegistrationAgree(probe, accountId, 'declined card');

        // 4. And the original customer-visible check, still worth keeping.
        await selfcareActivityPage.navigateToTopUp();
        await selfcareTopupPage.assertHistoryEmpty();

        testLogger.log(
          `✓ TC 2.3b — account ${accountId}: declined payment not recorded ` +
          `[${probe.chargeVerdict}], balance ${String(probe.balanceBefore)} -> ` +
          `${String(probe.balanceAfter)}`,
        );
      },
    );

    // TC 2.4 — Rapid double-click Pay Now (frontend idempotency, spec TC 3.4)
    test(
      '2.4: Rapid double-click Pay Now — only one top-up recorded (frontend idempotency)',
      { tag: ['@tc-2-4'] },
      async ({
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await setUpAccountForTopUp({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
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
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await setUpAccountForTopUp({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
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

        // ── Tell "endpoint broken" apart from "dedup broken" ──────────
        // The two assertions below both read a 0-SUCCESS result as a dedup
        // failure. But 0 SUCCESS means NEITHER post landed, so idempotency was
        // never exercised at all -- the opposite of what the message claims.
        //
        // That cost real time on 2026-08-24: both requests came back
        // SYSTEM_ERROR / "Cannot get property 'id' on null object" and the case
        // reported "expected exactly 1 SUCCESS", which reads as a dedup defect.
        // The endpoint was simply down. (Per the team's bug report that error is
        // the account-has-no-subscription path, since given better handling.)
        //
        // This still FAILS -- an unusable endpoint must never go green -- it just
        // states the true reason.
        if (successes === 0) {
          const detail = [json1, json2]
            .map((j, i) => `request${i + 1}: status=${j.status ?? '-'} `
              + `errorCode=${j.errorCode ?? '-'} errorMsg=${j.errorMsg ?? '-'}`)
            .join('  |  ');
          test.info().annotations.push({
            type: 'inconclusive',
            description: `TC 2.5 never exercised idempotency -- neither POST succeeded. ${detail}`,
          });
          throw new Error(
            'TC 2.5 INCONCLUSIVE -- neither top-up POST succeeded, so backend idempotency '
            + 'was never tested. This is an ENDPOINT failure, not a dedup failure: fix the '
            + `endpoint before reading anything into this case.  ${detail}`,
          );
        }

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
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        test.skip(!RECEIPTS_ENABLED, RECEIPTS_SKIP_REASON);

        const accountId = await ensureSharedAccountAndAttach({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
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
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        test.skip(!RECEIPTS_ENABLED, RECEIPTS_SKIP_REASON);

        const accountId = await ensureSharedAccountAndAttach({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
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
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        test.skip(!RECEIPTS_ENABLED, RECEIPTS_SKIP_REASON);

        const accountId = await ensureSharedAccountAndAttach({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
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
        page, testLogger, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage,
        placeToPayCheckoutPage,
      }) => {
        test.skip(!RECEIPTS_ENABLED, RECEIPTS_SKIP_REASON);

        const accountId = await setUpAccountForTopUp({
          page, testLogger, accountOrderApiHelper, searchAccountsPage, createAccountPage,
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
        page, testLogger, accountOrderApiHelper,
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
        // NOT setUpAccountForTopUp: TC 2.10 asserts the "Medidor" (Meter ID) field on
        // the receipt PDF, and the CRM gateway cannot attach a meter. This one must
        // keep building its account through the Core UI order flow.

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


    // -- TC 2.11 / 2.12 - a top-up must never take money without registering it --
    //
    // Reported by dev 2026-08-27. The flow makes TWO calls: one to PlaceToPay to
    // CHARGE the card, one to the CRM gateway to REGISTER the top-up. They are not
    // atomic. When the account has no subscription, or its subscription is CLOSED,
    // the charge still goes through and the registration does not -- the customer
    // loses money and nothing is credited. ACTIVE and SUSPENDED both work; only
    // closed or absent triggers it.
    //
    // The assertion is a biconditional, which is what dev asked for -- "both must
    // succeed together or fail together":
    //
    //     charged  <=>  registered
    //
    // `charged` is only observable ON THE WIRE. The PlaceToPay charge writes no row
    // on our side; core_engine.subscription_topup is written by the REGISTER call
    // alone. So every PlaceToPay and CRM-gateway response is recorded and logged --
    // the automated equivalent of watching the Network tab, which is how dev asked
    // for this to be checked.

    type TopUpProbe = {
      reachedGateway: boolean;
      charged: boolean;
      chargeVerdict: string;
      chargedAmount: number | null;
      registerAcked: boolean | null;
      registeredAmount: number | null;
      registered: boolean;
      topUpsBefore: number;
      topUpsAfter: number;
      balanceBefore: number | null;
      balanceAfter: number | null;
      blockedBy: string;
      calls: string[];
    };

    /**
     * Drive one top-up and report whether the money moved and whether it was
     * registered.
     *
     * WHERE THE SIGNALS COME FROM. Both are READ off the wire, not inferred.
     * Captured from a real approve and a real deny on 2026-08-28:
     *
     *   POST payment-gateway/transaction/placetopay/verify
     *     approve -> {"successful":true, "status":"APPROVED","resultCode":"00",
     *                 "message":"Aprobado","amount":500,...}
     *     deny    -> {"successful":false,"status":"REJECTED","resultCode":"05",
     *                 "message":"No honrar","amount":500,...}
     *
     *   POST crm-gateway/prepaidTopUp
     *     approve -> {"accountId":"AC-...","amountRecharged":500,
     *                 "subscriptionId":"SUB-...","status":"SUCCESS"}
     *     deny    -> NOT CALLED AT ALL (correct: no charge, nothing to register)
     *
     * Two traps this avoids:
     *
     *  - HTTP status is useless here. The DECLINED charge also returns 200; the
     *    rejection lives in the body. An earlier version of this probe inferred
     *    "charged" from "the approve flow completed without throwing", which would
     *    have reported a declined payment as a charge and produced a false
     *    MONEY LOST against an account that was never debited.
     *  - PlaceToPay's own /process is NOT a usable verdict: on the declined run it
     *    returned status "ACTIVE", not a rejection. Only /verify is decisive, and
     *    it has the further advantage of being Embrix's own view of whether money
     *    moved, on our own domain.
     */
    async function probeTopUp(
      f: {
        page: Page;
        testLogger: TestLogger;
        dbHelper: DbHelper;
        selfcareActivityPage: SelfcareActivityPage;
        selfcareTopupPage: SelfcareTopupPage;
        placeToPayCheckoutPage: PlaceToPayCheckoutPage;
      },
      accountId: string,
      label: string,
      variant: PlaceToPayCardVariant = 'approve',
      amountOverride?: number,
    ): Promise<TopUpProbe> {
      const calls: string[] = [];
      let verifyBody: Record<string, unknown> | null = null;
      let registerBody: Record<string, unknown> | null = null;

      const record = async (res: Response) => {
        const url = res.url().split('?')[0];
        if (!/placetopay|crm-gateway/i.test(url)) return;
        calls.push(`${res.status()} ${res.request().method()} ${url}`);
        try {
          if (url.endsWith('/verify')) {
            verifyBody = (await res.json()) as Record<string, unknown>;
          } else if (url.endsWith('/prepaidTopUp')) {
            registerBody = (await res.json()) as Record<string, unknown>;
          }
        } catch {
          // Body not readable (redirect, or the page went away). The DB check
          // below still decides `registered`, so this is not fatal.
        }
      };
      f.page.on('response', record);

      // Status-agnostic on purpose. getAccountBalance resolves the balance unit
      // through an ACTIVE subscription, so it returns nothing for a SUSPENDED
      // account and the balance assertion below would silently skip on the very
      // leg where a top-up restores service. Null here means the account has no
      // balance unit at all -- the 2.11 no-subscription case, where "no balance
      // to move" is the point.
      const readBalance = async (): Promise<number | null> => {
        try {
          return await f.dbHelper.getCrcBalanceAnyState(accountId);
        } catch {
          return null;
        }
      };

      const topUpsBefore = await f.dbHelper.getTopUpCount(accountId);
      const balanceBefore = await readBalance();
      let reachedGateway = false;

      try {
        await f.selfcareActivityPage.navigateToTopUp();
        await f.selfcareTopupPage.assertLoaded();

        // Use the displayed minimum when the screen shows one, so a suspended
        // account is not refused for topping up below its own minimum.
        const shownMin = Number(await f.selfcareTopupPage.getDisplayedMinimumAmount());
        const amount =
          amountOverride ??
          (Number.isFinite(shownMin) && shownMin > 0 ? Math.ceil(shownMin) : 500);

        await f.selfcareTopupPage.enterAmount(amount);
        await f.selfcareTopupPage.clickPayWithPlaceToPay();

        await f.page.waitForURL(/placetopay/i, { timeout: LONG_WAIT });
        reachedGateway = true;

        await f.placeToPayCheckoutPage.completePaymentFlow(variant);
      } catch (err) {
        // Not a failure in itself. Refusing to start the flow is a perfectly good
        // way to "fail together" -- it means no money moved.
        f.testLogger.log(
          `[${label}] flow stopped before completing: ` +
          `${String((err as Error)?.message ?? err).slice(0, 160)}`,
        );
      }

      // If the flow never reached the gateway, record WHY, while the page is still
      // on the Top Up view. A pass built on a click timeout is worth very little:
      // Selfcare being down, or the host being slow, produces exactly the same
      // silence. Reading the button state turns "nothing happened" into "the
      // product refused", which is a claim that can actually fail.
      let blockedBy = '';
      if (!reachedGateway) {
        const st = await f.selfcareTopupPage.getPayWithPlaceToPayState();
        blockedBy =
          `payButton visible=${st.visible} enabled=${st.enabled}` +
          (st.message ? ` message="${st.message}"` : '');
      }

      // The register call can lag the redirect back, so allow a settle window
      // before concluding nothing was written.
      let topUpsAfter = topUpsBefore;
      let balanceAfter = balanceBefore;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        topUpsAfter = await f.dbHelper.getTopUpCount(accountId);
        balanceAfter = await readBalance();
        const rowAppeared = topUpsAfter > topUpsBefore;
        const balanceMoved =
          balanceBefore !== null && balanceAfter !== null &&
          Math.abs(balanceAfter - balanceBefore) > 0.005;
        // Wait for BOTH, so a row that lands before the balance catches up is not
        // read as "credited". If the balance never moves we use the full window
        // and then report it -- which is exactly the case worth catching.
        if (rowAppeared && (balanceMoved || balanceBefore === null)) break;
        await f.page.waitForTimeout(3_000);
      }

      f.page.off('response', record);

      const v = verifyBody as Record<string, unknown> | null;
      const r = registerBody as Record<string, unknown> | null;

      const charged = Boolean(v && v.successful === true && v.status === 'APPROVED');
      const chargeVerdict = v
        ? `${String(v.status)} resultCode=${String(v.resultCode)} "${String(v.message)}"`
        : '(no /verify response seen - the charge was never attempted)';

      const probe: TopUpProbe = {
        reachedGateway,
        charged,
        chargeVerdict,
        chargedAmount: v && typeof v.amount === 'number' ? v.amount : null,
        registerAcked: r ? r.status === 'SUCCESS' : null,
        registeredAmount:
          r && typeof r.amountRecharged === 'number' ? r.amountRecharged : null,
        registered: topUpsAfter > topUpsBefore,
        topUpsBefore,
        topUpsAfter,
        balanceBefore,
        balanceAfter,
        blockedBy,
        calls,
      };

      f.testLogger.log(
        `[${label}] ${accountId} | reachedGateway=${probe.reachedGateway} ` +
        `charged=${probe.charged} (${probe.chargeVerdict}) ` +
        `registerAcked=${String(probe.registerAcked)} registered=${probe.registered} ` +
        `(subscription_topup ${topUpsBefore} -> ${topUpsAfter}, ` +
        `balance ${String(balanceBefore)} -> ${String(balanceAfter)})` +
        (blockedBy ? ` | blocked: ${blockedBy}` : ''),
      );
      for (const c of calls) f.testLogger.log(`[${label}]   ${c}`);
      return probe;
    }

    function assertChargeAndRegistrationAgree(
      probe: TopUpProbe,
      accountId: string,
      what: string,
    ): void {
      // If the charge never even reached the gateway, the reason must be POSITIVE
      // evidence that the product refused it -- an absent or disabled button. A
      // bare timeout is not evidence: Selfcare being down looks identical, and a
      // case that accepts silence can pass while proving nothing. This is what
      // turns 2.11's no-subscription leg from "nothing happened" into "the product
      // would not let it happen".
      if (probe.blockedBy) {
        expect(
          probe.blockedBy,
          `${accountId} (${what}) never reached the gateway, but nothing shows the ` +
          `product prevented it. Recorded: ${probe.blockedBy}. A click timeout on an ` +
          `ENABLED button means the flow stalled for some other reason, and this leg ` +
          `proves nothing.`,
        ).toMatch(/enabled=false|visible=false/);
      }

      // The money-losing direction, asserted on its own so the failure message says
      // precisely what went wrong rather than "expected true to be false".
      expect(
        probe.charged && !probe.registered,
        `MONEY LOST: ${accountId} (${what}) was CHARGED at PlaceToPay ` +
        `[${probe.chargeVerdict}] but the top-up was never registered - ` +
        `core_engine.subscription_topup stayed at ${probe.topUpsBefore}. ` +
        `Calls seen: ${probe.calls.join(' | ') || '(none)'}`,
      ).toBe(false);

      // ...and the converse, so crediting without a charge is caught too.
      expect(
        probe.registered && !probe.charged,
        `${accountId} (${what}) registered a top-up without an approved charge ` +
        `[${probe.chargeVerdict}]. Calls seen: ${probe.calls.join(' | ') || '(none)'}`,
      ).toBe(false);

      // When both happened, they must be for the SAME money. A row written for a
      // different amount is still a defect, and a count-only check would miss it.
      if (probe.chargedAmount !== null && probe.registeredAmount !== null) {
        expect(
          probe.registeredAmount,
          `${accountId} (${what}) was charged ${probe.chargedAmount} but registered ` +
          `${probe.registeredAmount}`,
        ).toBe(probe.chargedAmount);
      }

      // A ROW IS NOT CREDIT. The customer's balance has to move, by exactly the
      // amount charged. Without this a top-up recorded but never applied reads as
      // a success -- the money is gone and the balance is untouched, which is the
      // same harm as not registering it at all.
      //
      // Inverted CRC: credit is NEGATIVE, so a top-up makes the balance MORE
      // negative. balanceAfter = balanceBefore - amount.
      if (
        probe.registered &&
        probe.balanceBefore !== null &&
        probe.balanceAfter !== null &&
        probe.chargedAmount !== null
      ) {
        const delta = probe.balanceAfter - probe.balanceBefore;
        expect(
          Math.abs(delta + probe.chargedAmount) < 0.01,
          `${accountId} (${what}) registered a top-up of ${probe.chargedAmount} but the ` +
          `balance moved by ${delta.toFixed(2)} (${probe.balanceBefore} -> ` +
          `${probe.balanceAfter}). Expected a move of ${(-probe.chargedAmount).toFixed(2)} ` +
          `-- inverted CRC, so a top-up makes the balance more negative.`,
        ).toBe(true);
      }

      // ...and when nothing was registered, nothing may have moved either.
      if (
        !probe.registered &&
        probe.balanceBefore !== null &&
        probe.balanceAfter !== null
      ) {
        const delta = probe.balanceAfter - probe.balanceBefore;
        expect(
          Math.abs(delta) < 0.01,
          `${accountId} (${what}) registered NO top-up, yet the balance moved by ` +
          `${delta.toFixed(2)} (${probe.balanceBefore} -> ${probe.balanceAfter}).`,
        ).toBe(true);
      }
    }

    /**
     * Attach to the first account in `state` that Self Care will actually open.
     *
     * Not every account in a given state is usable: AC-QCSMOKE-* carry a CLOSED
     * subscription but are smoke-test artefacts with no usable Self Care profile,
     * and attaching to one times out after 180s. Seen 2026-08-28, when picking
     * only the newest CLOSED subscription hit exactly that. So try candidates in
     * order and report a skip if none open, rather than failing on test data.
     */
    async function attachToFirstUsableAccount(
      dbHelper: DbHelper,
      testLogger: TestLogger,
      selfcareLoginPage: SelfcareLoginPage,
      selfcareAccountSearchPage: SelfcareAccountSearchPage,
      state: 'CLOSED' | 'ACTIVE' | 'SUSPENDED',
      alreadyLoggedIn = false,
    ): Promise<string | null> {
      const candidates = await dbHelper.findAccountsBySubscriptionState(state, 3);
      if (!candidates.length) {
        testLogger.log(
          `! no account with a ${state} subscription on this environment. ` +
          `Data state, not a defect.`,
        );
        return null;
      }
      for (const accountId of candidates) {
        try {
          if (alreadyLoggedIn) {
            // Re-running the full login inside one test, after a completed
            // PlaceToPay round trip, leaves the login form unrendered and every
            // candidate times out at 180s -- three of them burned 9 minutes on
            // 2026-08-28 and blew the test budget. The session is already good;
            // just switch which account it is pointed at.
            await selfcareAccountSearchPage.navigate();
            await selfcareAccountSearchPage.searchAndSelectAccount(accountId);
          } else {
            await attachToAccountInSelfCare(
              { selfcareLoginPage, selfcareAccountSearchPage }, accountId,
            );
          }
          return accountId;
        } catch (err) {
          testLogger.log(
            `  ${accountId} (${state}) could not be opened in Self Care, trying the ` +
            `next: ${String((err as Error)?.message ?? err).slice(0, 100)}`,
          );
        }
      }
      testLogger.log(
        `! none of the ${candidates.length} ${state} account(s) could be opened in ` +
        `Self Care: ${candidates.join(', ')}. Data state, not a defect.`,
      );
      return null;
    }

    test(
      '2.11: No subscription or a CLOSED one - the customer must not be charged',
      { tag: ['@tc-2-11'] },
      async ({
        page, testLogger, dbHelper,
        searchAccountsPage, createAccountPage,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
      }) => {
        // Two legs, each of which creates or opens an account and then waits out a
        // 60s registration settle window. The default budget is not enough.
        test.setTimeout(900_000);

        const f = {
          page, testLogger, dbHelper,
          selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
        };

        await test.step('account with NO subscription', async () => {
          // Created without an order on purpose - that is what leaves an account
          // with no subscription, and TS-01 already relies on such accounts
          // working in Self Care.
          const accountId = await createPrepaidAccountOnly(
            page, searchAccountsPage, createAccountPage, baseRow, testLogger,
          );
          await attachToAccountInSelfCare(
            { selfcareLoginPage, selfcareAccountSearchPage }, accountId,
          );

          const probe = await probeTopUp(f, accountId, '2.11 no-subscription');
          assertChargeAndRegistrationAgree(probe, accountId, 'no subscription');
        });

        await test.step('account with a CLOSED subscription', async () => {
          // Second attach in this test - the session from the first leg is still
          // good, so switch accounts rather than logging in again.
          const accountId = await attachToFirstUsableAccount(
            dbHelper, testLogger, selfcareLoginPage, selfcareAccountSearchPage,
            'CLOSED', true,
          );
          if (!accountId) {
            testLogger.log('! 2.11 CLOSED leg SKIPPED - see reason above.');
            return;
          }

          const probe = await probeTopUp(f, accountId, '2.11 closed-subscription');
          assertChargeAndRegistrationAgree(probe, accountId, 'subscription CLOSED');
        });
      },
    );

    test(
      '2.12: Active and suspended subscriptions both charge AND register',
      { tag: ['@tc-2-12'] },
      async ({
        page, testLogger, dbHelper, accountOrderApiHelper,
        searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
        selfcareLoginPage, selfcareAccountSearchPage,
        selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
      }) => {
        // Two legs, each a full Self Care journey plus a 60s registration settle
        // window, and the second may have to create an account first.
        test.setTimeout(900_000);

        const f = {
          page, testLogger, dbHelper,
          selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
        };

        // The controls for 2.11. Without them, a build that simply refused every
        // top-up would satisfy 2.11 perfectly while being far more broken.

        await test.step('ACTIVE subscription', async () => {
          // CREATED, not found - but the file's SHARED created account rather than
          // a brand new one per run.
          //
          // Created matters: searching for an "ACTIVE" account bit us on
          // 2026-08-28, when the newest match had effectivedate 2027-01-09 against
          // a clock of 2026-07-15. It was not actually in effect, so its
          // registration legitimately failed and read as MONEY LOST. A created
          // account is in effect by construction.
          //
          // Shared matters because jasec-dev already carries 876 accounts, 220 of
          // them subscription-less test residue, and a fresh account per run adds
          // to that for no benefit here. The shared one comes with prior top-up
          // history, which is fine: every assertion below is on DELTAS, not on
          // absolute counts or balances.
          const accountId = await ensureSharedAccountAndAttach({
            page, testLogger, accountOrderApiHelper,
            searchAccountsPage, createAccountPage, orderManagementPage, screenshotHelper,
            selfcareLoginPage, selfcareAccountSearchPage,
            selfcareActivityPage, selfcareTopupPage, placeToPayCheckoutPage,
          });

          const probe = await probeTopUp(f, accountId, '2.12 active');
          assertChargeAndRegistrationAgree(probe, accountId, 'subscription ACTIVE');

          expect
            .soft(probe.charged, `${accountId} (ACTIVE) was never charged`)
            .toBe(true);
          expect
            .soft(
              probe.registered,
              `${accountId} (ACTIVE) was charged but no top-up was registered`,
            )
            .toBe(true);
        });

        await test.step('SUSPENDED subscription', async () => {
          // Prefer a REAL suspended account: one that got there through the
          // product, which is a truer fixture than anything we can fabricate.
          // Already logged in from the ACTIVE leg, so switch accounts rather than
          // logging in again.
          let accountId = await attachToFirstUsableAccount(
            dbHelper, testLogger, selfcareLoginPage, selfcareAccountSearchPage,
            'SUSPENDED', true,
          );
          let synthetic = false;

          if (!accountId) {
            // Fallback: make one. Driving an account into debt and waiting for
            // CREDIT_LIMIT_ACTIONS is ts-04's job and costs ~17 minutes, so the
            // subscription is suspended directly instead. Created via the gateway
            // WITHOUT logging in again -- a second Self Care login inside one test
            // leaves the form unrendered and everything after it times out.
            testLogger.log(
              '2.12 SUSPENDED: no existing suspended account usable - creating one ' +
              'and forcing the state (SYNTHETIC, subscription row only).',
            );
            accountId = await createPrepaidAccountViaGateway(
              { testLogger, accountOrderApiHelper }, baseRow,
            );
            const subId = await dbHelper.setSubscriptionStatus(accountId, 'SUSPENDED');
            testLogger.log(`2.12 SUSPENDED: ${accountId} / ${subId} forced to SUSPENDED`);
            synthetic = true;

            await selfcareAccountSearchPage.navigate();
            await selfcareAccountSearchPage.searchAndSelectAccount(accountId);
          }

          // Confirm the state actually under test, rather than trusting either
          // the search or the forced update.
          const status = await dbHelper.getSubscriptionStatus(accountId);
          expect(
            status,
            `2.12 SUSPENDED leg expected a SUSPENDED subscription for ${accountId}`,
          ).toBe('SUSPENDED');
          testLogger.log(
            `2.12 SUSPENDED: using ${accountId} (${synthetic ? 'synthetic' : 'real'}), ` +
            `subscription status ${status}`,
          );

          const probe = await probeTopUp(f, accountId, '2.12 suspended');
          assertChargeAndRegistrationAgree(probe, accountId, 'subscription SUSPENDED');

          expect
            .soft(probe.charged, `${accountId} (SUSPENDED) was never charged`)
            .toBe(true);
          expect
            .soft(
              probe.registered,
              `${accountId} (SUSPENDED) was charged but no top-up was registered`,
            )
            .toBe(true);
        });
      },
    );

  },
);
