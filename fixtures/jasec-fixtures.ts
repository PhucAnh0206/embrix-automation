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
import { EmailHelper } from '../helpers/email.helper';

/**
 * Baseline JASEC sandbox CCP (current-cycle-processing) time. The
 * `jasecCcpBaseline` auto-fixture resets CCP to this value before every
 * JASEC test, so no test inherits residual state (e.g. a month-B CCP
 * from a cross-month test) from whichever test ran before it. Tests
 * that need a specific CCP value just call
 * `serverHelper.setAndVerifyCcpTime()` themselves — their explicit set
 * overrides the baseline.
 *
 * Override per environment with JASEC_CCP_BASELINE rather than editing this
 * literal: the tenant clock is shared and gets parked at different dates on
 * dev vs preprod, and a value committed here is wrong for one of them.
 *
 * KNOWN COST, read before changing a date-sensitive spec: the tenant clock is
 * frequently parked AHEAD of this baseline (dev sat at 2026-08-19 while this
 * read 2026-07-15), so the reset is usually a REWIND, and ServerHelper warns
 * about it on every test. It is tolerated because the date-sensitive specs pin
 * absolute July/August dates. Deriving the baseline forward-only from the live
 * clock is the real fix and is tracked separately — it changes the expected
 * values in TS-03, so it needs its own validation run.
 */
export const JASEC_CCP_BASELINE = process.env.JASEC_CCP_BASELINE ?? '2026-07-15';

/**
 * Test-level options, settable with `test.use({ ... })`.
 */
type JasecOptions = {
  /**
   * CCP date the `jasecCcpBaseline` auto-fixture parks the tenant clock at
   * before each test, or `null` to leave the clock ALONE.
   *
   * Opt out (`test.use({ ccpBaseline: null })`) when the spec owns the clock
   * itself. Two specs used to need ugly workarounds because they could not:
   * the notification TS-01 suite had to detect the rewind this fixture had just
   * performed and undo it before every reused-account test, and TS-04 went as
   * far as bypassing this whole fixture file — re-implementing page-factory's
   * `page` helpers by hand — purely to escape the reset.
   */
  ccpBaseline: string | null;
};

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
  /**
   * IMAP client for the TS-01 notification suite. Tenant-agnostic — lives here
   * only because JASEC is currently the sole consumer; promote it to
   * page-factory when Coope notification tests need it.
   */
  emailHelper: EmailHelper;
  /** Auto-fixture — resets CCP time before each test. Not destructured. */
  jasecCcpBaseline: void;
};

export const test = base.extend<JasecFixtures & JasecOptions>({
  ccpBaseline: [JASEC_CCP_BASELINE, { option: true }],

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

  // Connects lazily on the first waitForEmail(), so JASEC tests that never
  // touch email do not need NOTIFY_* configured.
  emailHelper: async ({ testLogger }, use) => {
    const helper = new EmailHelper(testLogger);
    try {
      await use(helper);
    } finally {
      await helper.disconnect();
    }
  },

  // Auto-fixture: reset sandbox CCP time to the JASEC baseline before every
  // test. Prevents state-bleed across tests that manipulate CCP (e.g. TS-03
  // cross-month tests leaving CCP at month B, then a later test creating a
  // fresh account under that CCP and failing "not effective until future").
  // Tests that need a specific CCP override this by calling
  // serverHelper.setAndVerifyCcpTime() themselves, or disable the reset
  // entirely with `test.use({ ccpBaseline: null })`.
  jasecCcpBaseline: [
    async ({ serverHelper, ccpBaseline }, use) => {
      // `null` means the spec manages the clock — do not touch it, and do not
      // even read it, so an opted-out spec costs zero GraphQL calls here.
      if (ccpBaseline !== null) {
        await serverHelper.setAndVerifyCcpTime(ccpBaseline);
      }
      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
