import { test as base } from '@playwright/test';
import { GLAccountsPage } from '../../../../pages/revenue-hub/configuration/glAccounts.page';

/**
 * Type definition for GL Account page fixtures.
 */
export type GLAccountsFixtures = {
  /** GLAccountsPage Page Object instance. */
  gLAccountsPage: GLAccountsPage;
};

/**
 * Playwright fixture extension for GLAccountsPage.
 */
export const gLAccountsFixtures = base.extend<GLAccountsFixtures>({
  gLAccountsPage: async ({ page }, use) => {
    const gLAccountsPage = new GLAccountsPage(page);
    await use(gLAccountsPage);
  },
});
