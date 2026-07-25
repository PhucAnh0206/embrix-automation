import { test as base } from '@playwright/test';
import { ManualPaymentPage } from '../../../../pages/ar-hub/payment/payments.page';
/**
 * Type definition for payment page fixtures.
 */
export type PaymentFixtures = {
  /** ManualPaymentPage Page Object instance. */
  manualPaymentPage: ManualPaymentPage;
};

/**
 * Playwright fixture extension for ManualPaymentPage.
 */
export const paymentFixtures = base.extend<PaymentFixtures>({
  manualPaymentPage: async ({ page }, use) => {
    const manualPaymentPage = new ManualPaymentPage(page);
    await use(manualPaymentPage);
  },
});
