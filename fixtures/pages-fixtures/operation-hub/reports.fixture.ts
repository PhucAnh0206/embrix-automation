import { test as base } from '@playwright/test';
import { ReportsPage } from '../../../pages/operations-hub/reports/reports.page';
/**
 * Type definition for Reports page fixtures.
 */
export type ReportsFixtures = {
  /** ReportsPage Page Object instance. */
  reportsPage: ReportsPage;
};

/**
 * Playwright fixture extension for ReportsPage.
 */
export const reportsFixtures = base.extend<ReportsFixtures>({
  reportsPage: async ({ page }, use) => {
    const reportsPage = new ReportsPage(page);
    await use(reportsPage);
  },
});
