import { test as base } from '@playwright/test';
import { CurrencyPage } from '../../../../pages/pricing-hub/Basic-configuration/currency.page';

/**
 * Type definition for currency page fixtures.
 */
export type CurrencyFixtures = {
  /** CurrencyPage Page Object instance. */
  currencyPage: CurrencyPage;
};

/**
 * Playwright fixture extension for CurrencyPage.
 */
export const currencyFixtures = base.extend<CurrencyFixtures>({
  currencyPage: async ({ page }, use) => {
    const currencyPage = new CurrencyPage(page);
    await use(currencyPage);
  },
});
