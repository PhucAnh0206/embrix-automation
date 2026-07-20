/**
 * JASEC-specific Playwright fixtures — layered on top of the team's
 * page-factory. Adds Self Care page objects, PlaceToPay checkout, JASEC
 * account creation, JASEC-flavored order management, and a JASEC DB helper.
 *
 * JASEC test suites should import { test, expect } from this file instead
 * of directly from ../fixtures/page-factory. Team fixtures remain available
 * because we extend page-factory's `test` — nothing is overridden except
 * `orderManagementPage` (widened to a JASEC subclass; still IS-A base class,
 * so any team code depending on the base still works).
 */

import { mergeTests } from '@playwright/test';
import { test as base } from './page-factory';
import { CreateAccountPage } from '../pages/customer-hub/customer-management/create-account.page';
import { JasecOrderManagementPage } from '../pages/customer-hub/order-management/jasec-order-management.page';
import { SelfcareLoginPage } from '../pages/selfcare/selfcare-login.page';
import { SelfcareAccountSearchPage } from '../pages/selfcare/selfcare-account-search.page';
import { SelfcareActivityPage } from '../pages/selfcare/selfcare-activity.page';
import { SelfcareTopupPage } from '../pages/selfcare/selfcare-topup.page';
import { PlaceToPayCheckoutPage } from '../pages/selfcare/placetopay-checkout.page';
import { DbHelper } from '../helpers/db.helper';

type JasecFixtures = {
  createAccountPage: CreateAccountPage;
  // Overrides team's `orderManagementPage` with a JASEC subclass. Kept
  // under the same name so JASEC test destructuring stays natural.
  orderManagementPage: JasecOrderManagementPage;
  selfcareLoginPage: SelfcareLoginPage;
  selfcareAccountSearchPage: SelfcareAccountSearchPage;
  selfcareActivityPage: SelfcareActivityPage;
  selfcareTopupPage: SelfcareTopupPage;
  placeToPayCheckoutPage: PlaceToPayCheckoutPage;
  dbHelper: DbHelper;
};

export const test = base.extend<JasecFixtures>({
  createAccountPage: async ({ page }, use) => {
    await use(new CreateAccountPage(page));
  },

  orderManagementPage: async ({ page }, use) => {
    await use(new JasecOrderManagementPage(page));
  },

  selfcareLoginPage: async ({ page }, use) => {
    await use(new SelfcareLoginPage(page));
  },

  selfcareAccountSearchPage: async ({ page }, use) => {
    await use(new SelfcareAccountSearchPage(page));
  },

  selfcareActivityPage: async ({ page }, use) => {
    await use(new SelfcareActivityPage(page));
  },

  selfcareTopupPage: async ({ page }, use) => {
    await use(new SelfcareTopupPage(page));
  },

  placeToPayCheckoutPage: async ({ page }, use) => {
    await use(new PlaceToPayCheckoutPage(page));
  },

  dbHelper: async ({ testLogger }, use) => {
    const db = new DbHelper(testLogger);
    await db.connect();
    try {
      await use(db);
    } finally {
      await db.disconnect();
    }
  },
});

export { expect } from '@playwright/test';
