/**
 * TS-01 — Manage Credit Card
 *
 * Tests:
 *   1.1 Save Card with PlaceToPay — valid card → tokenization OK
 *   1.2 Abandon PlaceToPay session — start save, then abandon
 *   1.3 Declined card submission — invalid card → declined, not saved
 *   1.4 Delete a saved card
 *
 * Each test creates its own fresh account (account-only; no subscription
 * needed for card management flows).
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import {
  setUpAccountAndEnterManagePaymentProfile,
  type PrepaidAccountRow,
} from '../../../../fixtures/create-prepaid-account.helper';

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const dataRows: PrepaidAccountRow[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const baseRow = dataRows[0];

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
        const accountId = await setUpAccountAndEnterManagePaymentProfile({
          page, testLogger, searchAccountsPage, createAccountPage,
          selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
        }, baseRow);

        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.completeTokenization('approve');
        await selfcareActivityPage.assertCardOnFilePopulated();

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
        await selfcareActivityPage.assertCardOnFileEmpty();

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
        await selfcareActivityPage.assertCardOnFileEmpty();

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
        const accountId = await setUpAccountAndEnterManagePaymentProfile({
          page, testLogger, searchAccountsPage, createAccountPage,
          selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
        }, baseRow);

        // Precondition: save a card so we have something to delete.
        await selfcareActivityPage.clickSaveWithPlaceToPay();
        await placeToPayCheckoutPage.completeTokenization('approve');
        await selfcareActivityPage.assertCardOnFilePopulated();

        await selfcareActivityPage.deleteSavedCard();
        await selfcareActivityPage.assertCardOnFileEmpty();

        testLogger.log(`✓ TC 1.4 — account ${accountId} card saved and then removed`);
      },
    );
  },
);
