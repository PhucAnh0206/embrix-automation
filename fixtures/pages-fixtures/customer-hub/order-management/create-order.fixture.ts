import { test as base } from '@playwright/test';
import { CreateOrderPage } from '../../../../pages/customer-hub/order-management/create-order.page';
/**
 * Type definition for order management fixtures.
 */
export type CreateOrderFixtures = {
  /** OrderManagementPage Page Object instance. */
  createOrderPage: CreateOrderPage;
};

/**
 * Playwright fixture extension for OrderManagementPage.
 */
export const createOrderFixtures = base.extend<CreateOrderFixtures>({
  createOrderPage: async ({ page }, use) => {
    const createOrderPage = new CreateOrderPage(page);
    await use(createOrderPage);
  },
});
