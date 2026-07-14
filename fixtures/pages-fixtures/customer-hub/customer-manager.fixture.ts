import { test as base } from '@playwright/test';
import { SearchAccountsPage } from '../../../pages/customer-hub/customer-management/search-accounts.page';

/**
 * Type definition for customer management fixtures.
 */
export type CustomerManagementFixtures = {
    /** SearchAccountsPage Page Object instance. */
    searchAccountsPage: SearchAccountsPage;
};

/**
 * Playwright fixture extension for CustomerManagementPage.
 */
export const customerManagementFixture = base.extend<CustomerManagementFixtures>({
    searchAccountsPage: async ({ page }, use) => {
        const searchAccountsPage = new SearchAccountsPage(page);
        await use(searchAccountsPage);
    },
});
