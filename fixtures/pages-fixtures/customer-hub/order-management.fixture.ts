import { test as base } from '@playwright/test';
import { OrderManagementPage } from '../../../pages/customer-hub/order-management/order-management.page';

/**
 * Type definition for order management fixtures.
 */
export type OrderManagementFixtures = {
  /** OrderManagementPage Page Object instance. */
  orderManagementPage: OrderManagementPage;
};

/**
 * Playwright fixture extension for OrderManagementPage.
 */
export const orderManagementFixture = base.extend<OrderManagementFixtures>({
  orderManagementPage: async ({ page }, use) => {
    const orderManagementPage = new OrderManagementPage(page);
    await use(orderManagementPage);
  },
});
