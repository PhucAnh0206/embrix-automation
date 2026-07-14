import { test as base } from '@playwright/test';
import { TaxationPage } from '../../../../pages/billing-hub/Bulk-operations/taxation.page';

/**
 * Type definition for taxation page fixtures.
 */
export type TaxationFixtures = {
  /** TaxationPage Page Object instance. */
  taxationPage: TaxationPage;
};

/**
 * Playwright fixture extension for TaxationPage.
 */
export const taxationFixtures = base.extend<TaxationFixtures>({
  taxationPage: async ({ page }, use) => {
    const taxationPage = new TaxationPage(page);
    await use(taxationPage);
  },
});
