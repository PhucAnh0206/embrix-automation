import { test as base } from '@playwright/test';
import { BundlePage } from '../../../../pages/pricing-hub/Basic-configuration/bundle.page';
/**
 * Type definition for bundle management page fixtures.
 */
export type BundleFixtures = {
  /** BundlePage Page Object instance. */
  bundlePage: BundlePage;
};

/**
 * Playwright fixture extension for BundlePage.
 */
export const bundleFixtures = base.extend<BundleFixtures>({
  bundlePage: async ({ page }, use) => {
    const bundlePage = new BundlePage(page);
    await use(bundlePage);
  },
});
