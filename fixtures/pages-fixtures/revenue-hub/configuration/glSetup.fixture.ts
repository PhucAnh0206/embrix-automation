import { test as base } from '@playwright/test';
import { GLSetupPage } from '../../../../pages/revenue-hub/configuration/glSetup.page';
/**
 * Type definition for GL Setup page fixtures.
 */
export type GLSetupFixtures = {
  /** GLSetupPage Page Object instance. */
  gLSetupPage: GLSetupPage;
};

/**
 * Playwright fixture extension for GLSetupPage.
 */
export const gLSetupFixtures = base.extend<GLSetupFixtures>({
  gLSetupPage: async ({ page }, use) => {
    const gLSetupPage = new GLSetupPage(page);
    await use(gLSetupPage);
  },
});
