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
import { SelfcareMakePaymentPage } from '../pages/selfcare/selfcare-make-payment.page';
import { SelfcarePaymentsPage } from '../pages/selfcare/selfcare-payments.page';
import { PlaceToPayCheckoutPage } from '../pages/selfcare/placetopay-checkout.page';
import { DbHelper, hasDbConfig } from '../helpers/db.helper';
import { EmailHelper } from '../helpers/email.helper';
import { CLOCK_RESTORE } from '../helpers/clock-policy';

/**
 * Baseline JASEC sandbox CCP (current-cycle-processing) time. The
 * `jasecCcpBaseline` auto-fixture resets CCP to this value before every
 * JASEC test, so no test inherits residual state (e.g. a month-B CCP
 * from a cross-month test) from whichever test ran before it. It is NOT put
 * back afterwards on test tenants (helpers/clock-policy.ts): a case that runs
 * next picks its own date. Tests
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
  /** Activity → Make Payment (invoice settlement). Not the wallet screen. */
  selfcareMakePaymentPage: SelfcareMakePaymentPage;
  /** Billing Data → Payments, the CUSTOMER-facing grid (Core UI's is a different one). */
  selfcarePaymentsPage: SelfcarePaymentsPage;
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

  selfcareMakePaymentPage: async ({ page }, use) => {
    await use(new SelfcareMakePaymentPage(page));
  },

  selfcarePaymentsPage: async ({ page }, use) => {
    await use(new SelfcarePaymentsPage(page));
  },

  placeToPayCheckoutPage: async ({ page }, use) => {
    await use(new PlaceToPayCheckoutPage(page));
  },

  dbHelper: async ({ testLogger }, use, testInfo) => {
    // No DB credentials is an unmet PRECONDITION, not a product failure:
    // report BLOCKED (printed, since the list reporter hides skip reasons).
    if (!hasDbConfig()) {
      const why = 'BLOCKED, not failed: this test needs direct DB access and no DB_* credentials are configured for this tenant';
      console.log(`
  ${why}
`);
      testInfo.skip(true, why);
      return;
    }
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
  //
  // CLOCK: the clock is shared by the whole tenant. The fixture moves it to the baseline at the START of the test - the
  // one deliberate backward move on test tenants - and leaves it there: it is put back at the end only where
  // CLOCK_RESTORE says so (prod, or JASEC_CLOCK_RESTORE=true; helpers/clock-policy.ts). JASEC_CLOCK_RESET=false opts
  // out (the test then reports BLOCKED instead of touching the clock).
  jasecCcpBaseline: [
    async ({ serverHelper, ccpBaseline }, use, testInfo) => {
      // `null` means the spec manages the clock — do not touch it, and do not
      // even read it, so an opted-out spec costs zero GraphQL calls here.
      if (ccpBaseline === null) { await use(); return; }
      // JASEC_CLOCK_KEEP=true (2026-10-20): run on the tenant's CURRENT clock. For seeds whose account a later step
      // (a server script) uses at the current clock - e.g. the rating cases: an account seeded at the baseline on preprod (clock
      // 11-xx) had no open billing cycle when its readings arrived, so the kWh accumulator stayed 0 and tax/tiers broke.
      if (String(process.env.JASEC_CLOCK_KEEP ?? '').trim().toLowerCase() === 'true') { await use(); return; }
      if (String(process.env.JASEC_CLOCK_RESET ?? '').trim().toLowerCase() === 'false') {
        const why = `BLOCKED, not failed: this test first sets the tenant clock to ${ccpBaseline}, and JASEC_CLOCK_RESET=false forbids it.`;
        console.log(`\n  ${why}\n`);
        testInfo.skip(true, why);
        return;
      }
      const before = String(await serverHelper.getCcpTime()).slice(0, 10);
      await serverHelper.setAndVerifyCcpTime(ccpBaseline);
      try {
        await use();
      } finally {
        if (/^\d{4}-\d{2}-\d{2}$/.test(before) && before !== ccpBaseline && CLOCK_RESTORE) {
          await serverHelper.setAndVerifyCcpTime(before)
            .catch(e => console.log(`\n  WARNING: tenant clock NOT restored to ${before} (left at the test's date): ${e}\n`));
        }
      }
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
