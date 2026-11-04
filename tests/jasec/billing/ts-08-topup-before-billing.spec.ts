/**
 * Tags: @jasec @billing @topup-precondition
 *
 * B4 PRECONDITION — put a REAL top-up on an account before its cycle is billed.
 *
 * WHY THIS EXISTS
 *
 * JEPYP-47 (WandaV, 2026-07-10) defines the prepaid monthly invoice as a
 * "consolidated monthly invoice ... containing a summary of all top-ups completed
 * during the billing period". Nothing in the suite could produce that situation:
 * `run-billing-cycle-e2e.ps1` says so itself —
 *
 *     WHAT IT DOES NOT DO. It does not top up. ... see -TopUpFirst below, which
 *     is deliberately left unimplemented until we decide whether the cycle
 *     should be seeded with one.
 *
 * so every invoice it produced carried `top-ups 0 totalling 0` and the top-up
 * half of the monthly invoice was untestable. This is that missing step.
 *
 * THE TOP-UP MUST BE REAL. There is no API or gateway top-up helper, and staging
 * a `core_engine.subscription_topup` row by hand would be fabricating the very
 * thing under test — the invoice would then summarise data the product never
 * created. So this drives the actual Self Care flow: save a card through
 * PlaceToPay, then Pay Now. That is the same path ts-02 case 2.2 exercises and
 * passes.
 *
 * GATED, AND INERT BY DEFAULT. It spends money on a real (test) card and it is a
 * precondition rather than a case, so it only runs when asked:
 *
 *     JASEC_TOPUP_RUN=true                      required, or every test skips
 *     JASEC_TOPUP_ACCOUNT=ACT-100xxx            optional; falls back to the
 *                                               handoff file below
 *     JASEC_TOPUP_AMOUNT=5000                   optional, default 5000
 *
 * Invoked by `run-billing-cycle-e2e.ps1 -TopUpFirst`, which passes the account it
 * just seeded. Run by hand as:
 *
 *     $env:JASEC_TOPUP_RUN='true'; $env:JASEC_TOPUP_ACCOUNT='ACT-100826'
 *     npx playwright test --project=jasec-billing-run `
 *       tests/jasec/billing/ts-08-topup-before-billing.spec.ts
 *
 * ORDERING IS THE CALLER'S JOB. Playwright orders files alphabetically, so
 * `ts-06-billing-run` would otherwise run BEFORE `ts-08-topup-before-billing` and bill
 * the cycle before the top-up landed in it. The PowerShell wrapper therefore
 * invokes this file explicitly, as its own run, before the billing step. Do not
 * rely on both being picked up by one project-wide invocation.
 *
 * Tester: Anh Tran (QC)
 */
import * as fs from 'fs';
import { test, expect } from '../../../fixtures/jasec-fixtures';
import { attachToAccountInSelfCare } from '../../../fixtures/create-prepaid-account.helper';
import { PrepaidSeedHelper } from '../../../helpers/prepaid-seed.helper';
import { tenantArtifactPath } from '../../../helpers/tenant-paths';
import { accountLatestDate } from '../../../helpers/clock-policy';

// THE SPEC OWNS THE CLOCK (2026-10-13). The fixture's default reset to the 07-15 baseline put the
// top-up OUTSIDE the cycle about to be billed (preprod: ACT-100258's open cycle was 10-12..11-11), so
// the invoice could not summarise it and Self Care's history - current period only - showed no row.
// The test now moves the clock inside the account's OPEN cycle itself; an explicit JASEC_CCP_BASELINE
// (JASEC_CCP_BASELINE) still wins.
test.use({ ccpBaseline: null });

const RUN = process.env.JASEC_TOPUP_RUN === 'true';
const AMOUNT = Number(process.env.JASEC_TOPUP_AMOUNT ?? 5000);

/**
 * The account to top up. Explicit env wins; otherwise read the tariff-calculation handoff file,
 * which is where `run-billing-cycle-e2e.ps1` leaves the account it just seeded
 * (output/artifacts/<TEST_ENV>/jasec-latest-meter.json). Prefer the env var when the
 * caller has the id.
 */
function resolveAccountId(): string | null {
  const explicit = (process.env.JASEC_TOPUP_ACCOUNT ?? '').trim();
  if (explicit) return explicit;

  // Read from output/artifacts/, never output/test-results/: Playwright clears output/test-results/
  // around runs, so a handoff left only there can disappear between ts-01
  // writing it and this spec reading it (observed 2026-09-14).
  // Per tenant since 2026-10-14 (helpers/tenant-paths.ts) - never another tenant's handoff.
  const handoff = tenantArtifactPath('jasec-latest-meter.json');
  try {
    const raw = JSON.parse(fs.readFileSync(handoff, 'utf-8'));
    const id = String(raw.accountId ?? raw.account ?? '').trim();
    return id || null;
  } catch {
    return null;
  }
}

test.describe('B4 precondition — a real top-up inside the billed cycle', () => {
  test.skip(!RUN, 'JASEC_TOPUP_RUN is not true — this precondition is opt-in.');

  test(
    'tops up (direct PlaceToPay payment, no saved card) the account that is about to be billed @jasec @billing @topup-precondition', { tag: ['@tc-148'] },
    async ({
      selfcareLoginPage,
      selfcareAccountSearchPage,
      selfcareActivityPage,
      selfcareTopupPage,
      placeToPayCheckoutPage,
      dbHelper,
      testLogger,
    }) => {
      // A card tokenization plus a gateway round trip, on a host that drops
      // connections under load. ts-02 budgets similarly.
      test.setTimeout(600_000);

      const accountId = resolveAccountId();
      expect(
        accountId,
        'No account to top up. Pass JASEC_TOPUP_ACCOUNT, or run this straight ' +
        'after a seed so output/test-results/jasec-latest-meter.json still exists.',
      ).not.toBeNull();

      // ── Put the clock INSIDE the cycle that will be billed ──────────────
      const cyc = await dbHelper.query<{ s: string; e: string }>(
        `SELECT bu.startdate::date::text AS s, bu.enddate::date::text AS e
           FROM core_engine.billing_profile bp JOIN core_engine.bill_unit bu ON bu.id = bp.nextbillunitid
          WHERE bp.accountid = $1`, [accountId!]);
      expect(cyc.length, `${accountId} has no open bill unit - nothing will be billed`).toBe(1);
      const { s: cycStart, e: cycEnd } = cyc[0];
      const seed = new PrepaidSeedHelper(testLogger);
      const explicit = (process.env.JASEC_CCP_BASELINE ?? '').trim();
      const now = await seed.ccpDate();
      let target = explicit || now;
      if (!explicit && !(now >= cycStart && now < cycEnd)) {
        // Inside the cycle, but never before what the account already has (the clock is not put back between runs).
        const latest = await accountLatestDate(dbHelper, accountId!);
        target = latest > cycStart ? latest : cycStart;
      }
      expect(target >= cycStart && target < cycEnd,
        `${target} is outside ${accountId}'s open cycle ${cycStart}..${cycEnd}: the top-up would not be on the invoice`).toBe(true);
      if (target !== now) await seed.setCcpDate(target);
      testLogger.log(`[B4] open cycle ${cycStart}..${cycEnd}; clock ${now} -> ${target}`);

      testLogger.log(`[B4] topping up ${accountId} with ${AMOUNT} CRC`);

      // Count BEFORE. The assertion at the end is a DELTA, not an absolute: the
      // account may legitimately already have top-ups, and asserting "exactly 1"
      // would fail on a re-run for the wrong reason.
      const before = await dbHelper.getTopUpCount(accountId!);
      testLogger.log(`[B4] top-ups before: ${before}`);

      await attachToAccountInSelfCare(
        { selfcareLoginPage, selfcareAccountSearchPage },
        accountId!,
      );

      // ── Top up by paying PlaceToPay DIRECTLY — no saved card ──────────
      //
      // This case is about the top-up showing on the invoice, so it uses the
      // plain customer path. The saved-card path is NOT dropped: it is its own
      // case (billing/ts-12-saved-card-account-invoiced.spec.ts), because saving
      // a card is a known product defect, JEPYP-326 - recorded 2026-10-05. We
      // first met it here on 2026-09-08 and only worked around it, which is why
      // it reached UAT unreported. What happened then:
      //
      //   Saving a card sets payment_profile.paymentmethod to CREDIT_CARD.
      //   On a tenant whose DAILY template has no BILL_CC (dev, prod as of 2026-10-05;
      //   preprod has it since the JEPYP-326 fix) a CREDIT_CARD account is silently
      //   SKIPPED by the billing chain — rule 2
      //   in run-billing-cycle-e2e.ps1. Measured 2026-09-08: ACT-100832 and
      //   ACT-100833 both flipped to CREDIT_CARD after the card save, and step 5
      //   then aborted with "No CHECK account has a required billing date of
      //   2026-09-20", having billed nobody. The top-up had succeeded; it just
      //   disqualified its own account from being billed.
      //
      // Paying PlaceToPay directly leaves the payment method untouched, so the
      // account is still billable. It is also the canonical customer-facing path
      // (ts-02 case 2.3a), and it needs no stored token.
      await selfcareActivityPage.navigateToTopUp();
      await selfcareTopupPage.assertLoaded();
      await selfcareTopupPage.enterAmount(AMOUNT);
      await selfcareTopupPage.clickPayWithPlaceToPay();
      await placeToPayCheckoutPage.completePaymentFlow('approve');
      // Hard reload after returning from PlaceToPay — the Top Up view otherwise
      // serves a cached history state and the freshly-posted row is not visible.
      await selfcareTopupPage.reload(selfcareActivityPage);
      await selfcareTopupPage.assertPaymentSuccess();

      // ── Prove it reached the database, not just the screen ─────────────
      // The invoice's top-up summary is built from core_engine.subscription_topup,
      // so a green screen with no row would make the billing assertion vacuous.
      const after = await dbHelper.getTopUpCount(accountId!);
      testLogger.log(`[B4] top-ups after: ${after}`);
      expect(
        after,
        `${accountId}: Self Care reported success but subscription_topup did not ` +
        `gain a row (before=${before}, after=${after}). The billing-side top-up ` +
        `summary would have nothing to summarise.`,
      ).toBeGreaterThan(before);

      // ── The account must still be BILLABLE afterwards ──────────────────
      // A top-up that disqualifies its own account from being billed is worse
      // than no top-up: the chain then aborts two steps later with a confusing
      // "no CHECK account bills on this date". Assert it here, where the cause is
      // obvious. See the long note above the payment step for what did this.
      const pm = await dbHelper.query<{ paymentmethod: string }>(
        `SELECT paymentmethod FROM core_engine.payment_profile WHERE accountid = $1`,
        [accountId!],
      );
      const method = pm[0]?.paymentmethod ?? '(none)';
      testLogger.log(`[B4] payment method after top-up: ${method}`);
      expect(
        method,
        `${accountId}: payment method is now ${method}, not CHECK. Where the DAILY ` +
        `template has no BILL_CC (dev, prod - JEPYP-326) this account will ` +
        `be SILENTLY SKIPPED when the cycle is billed and the top-up summary will ` +
        `never be exercised. Something in the top-up path wrote a payment profile — ` +
        `saving a card does exactly that, which is why this spec pays PlaceToPay ` +
        `directly instead.`,
      ).toBe('CHECK');

      testLogger.log(
        `[B4] ready — ${accountId} now has ${after} top-up(s) and is still CHECK; ` +
        `bill its cycle to exercise the JEPYP-47 top-up summary`,
      );
    },
  );
});
