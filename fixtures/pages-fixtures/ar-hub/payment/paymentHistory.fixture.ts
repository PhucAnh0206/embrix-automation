import { test as base } from '@playwright/test';
import { PaymentHistoryPage } from '../../../../pages/ar-hub/payment/paymentHistory.page';
/**
 * Type definition for payment history page fixtures.
 */
export type PaymentFixtures = {
  /** PaymentHistoryPage Page Object instance. */
  paymentHistoryPage: PaymentHistoryPage;
};

/**
 * Playwright fixture extension for PaymentHistoryPage.
 */
export const paymentFixtures = base.extend<PaymentFixtures>({
  paymentHistoryPage: async ({ page }, use) => {
    const paymentHistoryPage = new PaymentHistoryPage(page);
    await use(paymentHistoryPage);
  },
});
