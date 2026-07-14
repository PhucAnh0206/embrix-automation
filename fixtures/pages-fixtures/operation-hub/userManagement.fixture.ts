import { test as base } from '@playwright/test';
import { UserManagementPage } from '../../../pages/operations-hub/user-management/userManagement.page';
/**
 * Type definition for User management page fixtures.
 */
export type UsersFixtures = {
  /** UserManagementPage Page Object instance. */
  userManagementPage: UserManagementPage;
};

/**
 * Playwright fixture extension for UserManagementPage.
 */
export const usersFixtures = base.extend<UsersFixtures>({
  userManagementPage: async ({ page }, use) => {
    const userManagementPage = new UserManagementPage(page);
    await use(userManagementPage);
  },
});
