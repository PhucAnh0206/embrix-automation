import { test as base } from '@playwright/test';
import { CollectionPage } from '../../../../pages/ar-hub/collections/accountInCollection.page';
/**
 * Type definition for collections page fixtures.
 */
export type CollectionFixtures = {
  /** CollectionPage Page Object instance. */
  collectionPage: CollectionPage;
};

/**
 * Playwright fixture extension for CollectionPage.
 */
export const collectionFixtures = base.extend<CollectionFixtures>({
  collectionPage: async ({ page }, use) => {
    const collectionPage = new CollectionPage(page);
    await use(collectionPage);
  },
});
