import { test as base } from '@playwright/test';
import { InvoicePage } from '../../../../pages/billing-hub/Bulk-operations/invoices.page';

/**
 * Type definition for invoice page fixtures.
 */
export type InvoiceFixtures = {
  /** InvoicePage Page Object instance. */
  invoicePage: InvoicePage;
};

/**
 * Playwright fixture extension for InvoicePage.
 */
export const invoiceFixtures = base.extend<InvoiceFixtures>({
  invoicePage: async ({ page }, use) => {
    const invoicePage = new InvoicePage(page);
    await use(invoicePage);
  },
});
