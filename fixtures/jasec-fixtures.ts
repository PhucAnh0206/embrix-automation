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

import { test as base } from './page-factory';
import { CreateAccountPage } from '../pages/customer-hub/customer-management/create-account.page';
import { JasecOrderManagementPage } from '../pages/customer-hub/order-management/jasec-order-management.page';
import { SelfcareLoginPage } from '../pages/selfcare/selfcare-login.page';
import { SelfcareAccountSearchPage } from '../pages/selfcare/selfcare-account-search.page';
import { SelfcareActivityPage } from '../pages/selfcare/selfcare-activity.page';
import { SelfcareTopupPage } from '../pages/selfcare/selfcare-topup.page';
import { PlaceToPayCheckoutPage } from '../pages/selfcare/placetopay-checkout.page';
import { DbHelper } from '../helpers/db.helper';

/**
 * Baseline JASEC sandbox CCP (current-cycle-processing) time. The
 * `jasecCcpBaseline` auto-fixture resets CCP to this value before every
 * JASEC test, so no test inherits residual state (e.g. a month-B CCP
 * from a cross-month test) from whichever test ran before it. Tests
 * that need a specific CCP value just call
 * `serverHelper.setAndVerifyCcpTime()` themselves — their explicit set
 * overrides the baseline.
 *
 * Change here when JASEC's sandbox calendar shifts.
 */
export const JASEC_CCP_BASELINE = '2026-07-15';

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
  /** Auto-fixture — resets CCP time before each test. Not destructured. */
  jasecCcpBaseline: void;
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

  // Auto-fixture: reset sandbox CCP time to the JASEC baseline before every
  // test. Prevents state-bleed across tests that manipulate CCP (e.g. TS-03
  // cross-month tests leaving CCP at month B, then a later test creating a
  // fresh account under that CCP and failing "not effective until future").
  // Tests that need a specific CCP override this by calling
  // serverHelper.setAndVerifyCcpTime() themselves.
  jasecCcpBaseline: [
    async ({ serverHelper }, use) => {
      await serverHelper.setAndVerifyCcpTime(JASEC_CCP_BASELINE);
      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
