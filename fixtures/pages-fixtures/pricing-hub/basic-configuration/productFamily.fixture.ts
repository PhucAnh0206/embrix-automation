import { test as base } from '@playwright/test';
import { ProductFamilyPage } from '../../../../pages/pricing-hub/Basic-configuration/productFamily.page';

/**
 * Type definition for product family page fixtures.
 */
export type ProductFamilyFixtures = {
  /** Product FamilyPage Page Object instance. */
  productFamilyPage: ProductFamilyPage;
};

/**
 * Playwright fixture extension for ProductFamilyPage.
 */
export const productFamilyFixtures = base.extend<ProductFamilyFixtures>({
  productFamilyPage: async ({ page }, use) => {
    const productFamilyPage = new ProductFamilyPage(page);
    await use(productFamilyPage);
  },
});
