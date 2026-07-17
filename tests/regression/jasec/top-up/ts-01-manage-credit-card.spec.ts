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
import { test, expect } from '../../../../fixtures/page-factory';
import { createPrepaidAccountOnly } from '../../../../fixtures/create-prepaid-account.helper';

interface JasecAccountTestRow {
  accountInfo: {
    accountCategory: string;
    customerSegment: string;
    customerId: string;
    legalEntity: string;
    accountType: string;
    currency?: string;
    sellingCompany?: string;
  };
  contact: { firstName: string; lastName: string; email: string; useAsBilling: boolean };
  address: {
    street: string;
    country: string;
    state: string;
    city: string;
    postalCode: string;
    useAsBilling: boolean;
  };
  paymentProfile: { paymentMethod: string; paymentTerm: string };
  billingProfile: { billingDom: string | number };
}

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const dataRows: JasecAccountTestRow[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const baseRow = dataRows[0];

const USERNAME = process.env.EMBRIX_USER ?? 'congeroadmin';
const PASSWORD = process.env.EMBRIX_PASSWORD ?? 'congero@123';

/** Create fresh account, log into Self Care, act as it, open Manage Payment Profile. */
async function setUpAccountAndEnterManagePaymentProfile(fixtures: {
  page: any;
  testLogger: any;
  searchAccountsPage: any;
  createAccountPage: any;
  selfcareLoginPage: any;
  selfcareAccountSearchPage: any;
  selfcareActivityPage: any;
}): Promise<string> {
  const {
    page, testLogger,
    searchAccountsPage, createAccountPage,
    selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage,
  } = fixtures;

  const accountId = await createPrepaidAccountOnly(
    page, searchAccountsPage, createAccountPage, baseRow, testLogger,
  );

  await selfcareLoginPage.goto();
  await selfcareLoginPage.login(USERNAME, PASSWORD);
  await selfcareLoginPage.assertLoginSuccess();

  await selfcareAccountSearchPage.navigate();
  await selfcareAccountSearchPage.searchAndSelectAccount(accountId);

  await selfcareActivityPage.navigateToManagePaymentProfile();

  return accountId;
}

test.describe(
  'TS-01 — Manage Credit Card',
  { tag: ['@regression', '@jasec', '@top-up', '@ts-01'] },
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
        });

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
        });

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
        });

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
        });

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
