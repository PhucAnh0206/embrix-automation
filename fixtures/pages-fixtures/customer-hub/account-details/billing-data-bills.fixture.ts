import { test as base } from '@playwright/test';
import { BillsPage } from '../../../../pages/customer-hub/customer-management/account-details/billing-data/bills.page';

/**
 * Type definition for bills page fixtures.
 */
export type BillsFixtures = {
  /** BillsPage Page Object instance. */
  billsPage: BillsPage;
};

/**
 * Playwright fixture extension for BillsPage.
 */
export const billsFixture = base.extend<BillsFixtures>({
  billsPage: async ({ page }, use) => {
    const billsPage = new BillsPage(page);
    await use(billsPage);
  },
});
