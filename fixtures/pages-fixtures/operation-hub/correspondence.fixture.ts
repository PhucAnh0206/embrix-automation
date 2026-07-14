import { test as base } from '@playwright/test';
import { CorrspondencePage } from '../../../pages/operations-hub/correspondence/correspondence.page';
/**
 * Type definition for Correspondence page fixtures.
 */
export type CorrespondenceFixtures = {
  /** CorrspondencePage Page Object instance. */
  corrspondencePage: CorrspondencePage;
};

/**
 * Playwright fixture extension for CorrspondencePage.
 */
export const correspondenceFixtures = base.extend<CorrespondenceFixtures>({
  corrspondencePage: async ({ page }, use) => {
    const corrspondencePage = new CorrspondencePage(page);
    await use(corrspondencePage);
  },
});
