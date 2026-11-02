import { test as base } from '@playwright/test';
import { NewQuote } from '../../../../pages/customer-hub/quote-management/new-quote.page';


export type NewQuoteFixtures = {
  newQuote: NewQuote;
};

export const newQuoteFixtures = base.extend<NewQuoteFixtures>({
  newQuote: async ({ page }, use) => {
    const newQuote = new NewQuote(page);
    await use(newQuote);
  },
});
