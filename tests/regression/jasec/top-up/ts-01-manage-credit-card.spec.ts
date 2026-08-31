/**
 * TS-01 — Manage Credit Card
 *
 * Tests:
 *   1.1 Save Card with PlaceToPay — valid card → tokenization OK
 *   1.2 Abandon PlaceToPay session — start save, then abandon
 *   1.3 Declined card submission — invalid card → declined, not saved
 *   1.4 Delete a saved card
 *
 * Accounts are account-only (no order/subscription — card management does not
 * need one), which is why setup here is cheaper than in TS-02/TS-03.
 *
 * Account-setup strategy. Each test used to create its own account, costing
 * 94-141s apiece (2026-08-20 run) for setup that is largely identical. One pair
 * shares now:
 *
 *   • 1.1 + 1.4 SHARE an account. 1.1 ends with a card saved, which is exactly
 *     the precondition 1.4 needs, so 1.4 skips both the account creation AND the
 *     PlaceToPay tokenization round trip. It still asserts the card is present
 *     before deleting, so a regression that dropped the token cannot let it
 *     "pass" by deleting nothing. Running 1.4 alone (`--grep @tc-1-4`) works
 *     unchanged — it creates and cards the account itself.
 *
 *   • 1.2 and 1.3 keep their OWN accounts, deliberately. They are both negative
 *     tests whose whole assertion is "no card was saved". Sharing would make a
 *     card leaked by 1.2's abandoned session surface as a failure in 1.3 —
 *     reading as "a declined card got saved", which is a different and much more
 *     alarming defect than the real one. The ~100s saved is not worth pointing
 *     the finger at the wrong code path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { DbHelper } from '../../../../helpers/db.helper';
import {
  setUpAccountAndEnterManagePaymentProfile,
  attachToAccountInSelfCare,
  type PrepaidAccountRow,
  type SetUpAccountOnlyFixtures,
} from '../../../../fixtures/create-prepaid-account.helper';
import { SharedAccount } from '../../../../fixtures/shared-account.helper';
import type { PlaceToPayCheckoutPage } from '../../../../pages/selfcare/placetopay-checkout.page';

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const dataRows: PrepaidAccountRow[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const baseRow = dataRows[0];

type CardFixtures = SetUpAccountOnlyFixtures & {
  placeToPayCheckoutPage: PlaceToPayCheckoutPage;
};

/**
 * Re-attach and land back on Manage Payment Profile — the view every test here
 * starts from, and where `setUpAccountAndEnterManagePaymentProfile` leaves a
 * freshly-created account.
 */
async function attachAndOpenPaymentProfile(
  fixtures: CardFixtures,
  accountId: string,
): Promise<void> {
  await attachToAccountInSelfCare(fixtures, accountId);
  await fixtures.selfcareActivityPage.navigateToManagePaymentProfile();
}

/** 1.1 saves a card; 1.4 deletes it. Same account, in that order. */
const cardedAccount = new SharedAccount<CardFixtures>({
  label: 'TS-01 carded (1.1, 1.4)',
  create: (fixtures) => setUpAccountAndEnterManagePaymentProfile(fixtures, baseRow),
  attach: attachAndOpenPaymentProfile,
});

/**
 * Confirm from the DATABASE that no card was saved.
 *
 * The UI cannot answer this. An empty Credit Card Token field is identical
 * whether nothing was ever saved or the PlaceToPay callback has not landed yet,
 * and waiting longer cannot resolve an absence -- so 1.2 and 1.3 could pass while
 * proving nothing, and would keep passing even if the product started saving
 * cards from abandoned or declined sessions.
 *
 * Built here instead of taken as a fixture ON PURPOSE: the `dbHelper` fixture
 * connects eagerly and is documented to fail fast when VPN is down, so declaring
 * it would turn these two UI-only cases into VPN-only ones. A connection failure
 * SKIPS the DB leg with the reason printed -- the UI settle window still ran, and
 * a blocked precondition is never reported as proof.
 */
/**
 * Is the card in core_engine.credit_card? Used ONLY to classify a UI timeout.
 *
 * Returns true / false, or null when the DB cannot be reached - in which case the
 * caller must report the original UI error rather than guess. A blocked oracle
 * never becomes evidence either way.
 */
async function confirmCardInDb(
  accountId: string,
  testLogger: { log: (message: string) => void },
): Promise<boolean | null> {
  const db = new DbHelper();
  try {
    await db.connect();
  } catch (err) {
    testLogger.log(
      `! DB oracle unavailable for ${accountId} ` +
      `(${String((err as Error)?.message ?? err).split('\n')[0]}). ` +
      `Cannot tell a slow render from a card that never saved.`,
    );
    return null;
  }
  try {
    const n = await db.getSavedCardCount(accountId);
    testLogger.log(`  DB oracle: ${n} card row(s) for ${accountId}`);
    return n > 0;
  } finally {
    await db.disconnect?.().catch(() => { });
  }
}

async function confirmNoCardInDb(
  accountId: string,
  testLogger: { log: (message: string) => void },
): Promise<void> {
  const db = new DbHelper();
  try {
    await db.connect();
  } catch (err) {
    const first = String((err as Error)?.message ?? err).split('\n')[0];
    testLogger.log(
      `! DB oracle SKIPPED for ${accountId} -- cannot connect (${first}). ` +
      `VPN down or DB_* not configured. The UI settle window ran, but ` +
      `"no card saved" is NOT proven by this run.`,
    );
    return;
  }
  try {
    const saved = await db.getSavedCardCount(accountId);
    expect(
      saved,
      `${accountId} must have NO saved card, but core_engine.credit_card has ${saved}`,
    ).toBe(0);
    testLogger.log(`checked DB oracle -- ${accountId} has 0 saved cards`);
  } finally {
    await db.disconnect();
  }
}

test.describe(
  'TS-01 — Manage Credit Card',
  { tag: ['@regression', '@jasec', '@top-up', '@ts-topup-01'] },
  () => {
    // ── TC 1.1 — Save Card with PlaceToPay ────────────────────────────
    test(
      '1.1: Save a valid test card via PlaceToPay tokenization',
      { tag: ['@tc-1-1'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage,
        selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await cardedAccount.ensure({
          page, testLogger, searchAccountsPage, createAccountPage,
          selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
          placeToPayCheckoutPage,
        });

        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.completeTokenization('approve');

        // SEPARATE "the card was saved" FROM "Self Care rendered it in time".
        //
        // These are different questions and the UI cannot tell them apart: an
        // empty token field looks the same whether nothing saved or the render
        // is late. On 2026-08-31 a tester hit the second case - eight re-fetches
        // over 69s all empty, while the card was in core_engine.credit_card the
        // whole time - and the suite reported it as a card-saving failure, which
        // reads as "the product is broken" when the product had worked.
        //
        // So on a UI timeout, ask the database what actually happened. The DB is
        // consulted ONLY to classify a failure, never to excuse one: no card in
        // credit_card still fails, and fails harder.
        try {
          await selfcareActivityPage.assertCardOnFilePopulated();
        } catch (uiErr) {
          const saved = await confirmCardInDb(accountId, testLogger);
          if (saved === true) {
            throw new Error(
              `${accountId}: the card WAS saved - core_engine.credit_card holds it - but ` +
              `Self Care did not render it inside the wait window. This is a UI/latency ` +
              `finding, NOT a card-saving failure. Raise JASEC_CARD_WAIT_MS for this ` +
              `environment, and report the render delay separately. UI error: ` +
              `${String((uiErr as Error)?.message ?? uiErr).split('\n')[0]}`,
            );
          }
          if (saved === false) {
            throw new Error(
              `${accountId}: no card in core_engine.credit_card AND the UI never showed ` +
              `one. The card genuinely was not saved - this is the real failure. ` +
              `UI error: ${String((uiErr as Error)?.message ?? uiErr).split('\n')[0]}`,
            );
          }
          throw uiErr;   // DB unreachable - cannot classify, so report as-is
        }

        testLogger.log(`✓ TC 1.1 — account ${accountId} has card saved`);
        expect(accountId).toMatch(/^(ACT|AC)-\d+$/);
      },
    );

    // ── TC 1.2 — Abandon PlaceToPay session ───────────────────────────
    test(
      '1.2: Abandon PlaceToPay session — no card saved',
      { tag: ['@tc-1-2'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage,
        selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await setUpAccountAndEnterManagePaymentProfile({
          page, testLogger, searchAccountsPage, createAccountPage,
          selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
        }, baseRow);

        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.abandonCheckoutSession();
        // settleMs: keep re-fetching for a while, so a LATE save is caught rather
        // than read as "never saved". Bounds the negative; the DB proves it.
        await selfcareActivityPage.assertCardOnFileEmpty({ settleMs: 15_000 });
        await confirmNoCardInDb(accountId, testLogger);

        testLogger.log(`✓ TC 1.2 — account ${accountId} has no card`);
      },
    );

    // ── TC 1.3 — Declined card submission ─────────────────────────────
    test(
      '1.3: Declined card submission — no card saved',
      { tag: ['@tc-1-3'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage,
        selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
        placeToPayCheckoutPage,
      }) => {
        const accountId = await setUpAccountAndEnterManagePaymentProfile({
          page, testLogger, searchAccountsPage, createAccountPage,
          selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
        }, baseRow);

        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.submitDeclinedCard();
        await selfcareActivityPage.assertCardOnFileEmpty({ settleMs: 15_000 });
        await confirmNoCardInDb(accountId, testLogger);

        testLogger.log(`✓ TC 1.3 — account ${accountId} did not save the declined card`);
      },
    );

    // ── TC 1.4 — Delete a saved card ──────────────────────────────────
    test(
      '1.4: Delete a previously saved card',
      { tag: ['@tc-1-4'] },
      async ({
        page, testLogger,
        searchAccountsPage, createAccountPage,
        selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
        placeToPayCheckoutPage,
      }) => {
        // When 1.1 has already run in this worker, its account still holds the
        // card this test exists to delete — so `alreadyCarded` is true and the
        // PlaceToPay tokenization round trip is skipped entirely. Run on its
        // own, this creates the account and saves the card itself.
        const alreadyCarded = cardedAccount.isCreated;
        const accountId = await cardedAccount.ensure({
          page, testLogger, searchAccountsPage, createAccountPage,
          selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
          placeToPayCheckoutPage,
        });

        if (!alreadyCarded) {
          // Precondition: save a card so we have something to delete.
          await selfcareActivityPage.clickSaveWithPlaceToPay();
          await placeToPayCheckoutPage.completeTokenization('approve');
        }

        // Asserted either way: reusing 1.1's account must not be taken on trust,
        // or a regression that silently dropped the token would make this test
        // "pass" by deleting nothing.
        await selfcareActivityPage.assertCardOnFilePopulated();

        await selfcareActivityPage.deleteSavedCard();
        await selfcareActivityPage.assertCardOnFileEmpty();

        testLogger.log(`✓ TC 1.4 — account ${accountId} card saved and then removed`);
      },
    );
  },
);
