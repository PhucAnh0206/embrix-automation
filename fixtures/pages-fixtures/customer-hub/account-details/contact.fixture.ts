import { test as base } from '@playwright/test';
import { ContactPage } from '../../../../pages/customer-hub/customer-management/account-details/account-data/contact.page';
/**
 * Type definition for contact info fixtures.
 */
export type ContactFixtures = {
  /** AccountInfoPage Page Object instance. */
  contactPage: ContactPage;
};

/**
 * Playwright fixture extension for AccountInfoPage.
 */
export const accountInfoFixture = base.extend<ContactFixtures>({
  contactPage: async ({ page }, use) => {
    const contactPage = new ContactPage(page);
    await use(contactPage);
  },
});
