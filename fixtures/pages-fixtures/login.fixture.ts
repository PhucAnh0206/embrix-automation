import { test as base } from '@playwright/test';
import { LoginPage } from '../../pages/login.page';

/**
 * Type definition for login page fixtures.
 */
export type LoginFixtures = {
  /** LoginPage Page Object instance. */
  loginPage: LoginPage;
};

/**
 * Playwright fixture extension for LoginPage.
 */
export const loginFixture = base.extend<LoginFixtures>({
  loginPage: async ({ page }, use) => {
    const loginPage = new LoginPage(page);
    await use(loginPage);
  },
});
