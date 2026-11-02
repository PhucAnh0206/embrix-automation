import { test as base } from '@playwright/test';
import { SearchQuote } from '../../../../pages/customer-hub/quote-management/search-quote.page';

export type SearchQuoteFixtures = {
  searchQuote: SearchQuote;
};

export const searchQuoteFixtures = base.extend<SearchQuoteFixtures>({
  searchQuote: async ({ page }, use) => {
    const searchQuote = new SearchQuote(page);
    await use(searchQuote);
  },
});
