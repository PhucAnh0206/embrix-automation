import { test as base } from '@playwright/test';
import { RevenuePage } from '../../../../pages/revenue-hub/revenue/revenue.page';

/**
 * Type definition for Revenue page fixtures.
 */
export type RevenueFixtures = {
  /** RevenuePage Page Object instance. */
  revenuePage: RevenuePage;
};

/**
 * Playwright fixture extension for RevenuePage.
 */
export const revenueFixtures = base.extend<RevenueFixtures>({
  revenuePage: async ({ page }, use) => {
    const revenuePage = new RevenuePage(page);
    await use(revenuePage);
  },
});
