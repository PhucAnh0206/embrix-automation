import { test as base } from '@playwright/test';
import { UsagePage } from '../../../../pages/billing-hub/Bulk-operations/usage.page';
 /**
 * Type definition for Usage page fixtures.
 */
export type UsageFixtures = {
  /** UsagePage Page Object instance. */
  usagePage: UsagePage;
};

/**
 * Playwright fixture extension for UsagePage.
 */
export const usageFixtures = base.extend<UsageFixtures>({
  usagePage: async ({ page }, use) => {
    const usagePage = new UsagePage(page);
    await use(usagePage);
  },
});
