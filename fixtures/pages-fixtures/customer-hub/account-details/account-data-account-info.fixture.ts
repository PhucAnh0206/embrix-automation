import { test as base } from '@playwright/test';
import { AccountInfoPage } from '../../../../pages/customer-hub/customer-management/account-details/account-data/account-info.page';

/**
 * Type definition for account info fixtures.
 */
export type AccountInfoFixtures = {
  /** AccountInfoPage Page Object instance. */
  accountInfoPage: AccountInfoPage;
};

/**
 * Playwright fixture extension for AccountInfoPage.
 */
export const accountInfoFixture = base.extend<AccountInfoFixtures>({
  accountInfoPage: async ({ page }, use) => {
    const accountInfoPage = new AccountInfoPage(page);
    await use(accountInfoPage);
  },
});
