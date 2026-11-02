import { test as base } from '@playwright/test';
import { AccountOrderApiHelper } from '../../helpers/account-order-api.helper';

/**
 * Type definition for account and order API fixtures.
 */
export type AccountOrderApiFixtures = {
  /** AccountOrderApiHelper instance for invoking CRM Gateway endpoints. */
  accountOrderApiHelper: AccountOrderApiHelper;
};

/**
 * Playwright fixture extension for AccountOrderApiHelper.
 */
export const accountOrderApiFixture = base.extend<AccountOrderApiFixtures>({
  accountOrderApiHelper: async ({ request }, use) => {
    const helper = new AccountOrderApiHelper(request);
    await use(helper);
  },
});
