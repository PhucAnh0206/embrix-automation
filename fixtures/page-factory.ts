import { test as base, mergeTests, TestInfo } from '@playwright/test';
import { Page, Locator } from '@playwright/test';
import { MEDIUM_WAIT, SHORT_WAIT } from '../helpers/timeouts.helper';

declare module '@playwright/test' {
  interface Page {
    navigateToHome(): Promise<void>;
    waitForLoadingToDisappear(): Promise<void>;
  }
}
import { AccountInfoPage } from '../pages/customer-hub/customer-management/account-details/account-data/account-info.page';
import { CustomerManagementPage } from '../pages/customer-hub/customer-management/customer-management.page';
import { BillsPage } from '../pages/customer-hub/customer-management/account-details/billing-data/bills.page';
import { DailySchedulePage } from '../pages/operations-hub/jobs-management/daily-schedule.page';
import { DatabaseHelper } from '../helpers/database.helper';
import { JobScheduleDbHelper } from '../helpers/db/job-schedule.db';
import { LoginPage } from '../pages/login.page';
import { OrderManagementPage } from '../pages/customer-hub/order-management/order-management.page';
import { ReactSelectComponent } from '../pages/components/react-select.component';
import { ScreenshotHelper } from '../helpers/screenshot.helper';
import { SearchAccountsPage } from '../pages/customer-hub/customer-management/search-accounts.page';
import { SidebarComponent } from '../pages/components/sidebar.component';
import { ServicesPage } from '../pages/customer-hub/customer-management/account-details/subscription-data/services.page';
import { TaskManagementPage } from '../pages/operations-hub/task-management/taskManagement.page';
import { CorrspondencePage } from '../pages/operations-hub/correspondence/correspondence.page';
import { TableComponent } from '../pages/components/table.component';
import { PaymentHistoryPage } from '../pages/ar-hub/payment/paymentHistory.page';
import { SearchQuote } from '../pages/customer-hub/quote-management/search-quote.page';
import { BundlePage } from '../pages/pricing-hub/Basic-configuration/bundle.page';
import { UserManagementPage } from '../pages/operations-hub/user-management/userManagement.page';
import { ContactPage } from '../pages/customer-hub/customer-management/account-details/account-data/contact.page';
import { CollectionPage } from '../pages/ar-hub/collections/accountInCollection.page';
import { UsagePage } from '../pages/billing-hub/Bulk-operations/usage.page';
import { NewQuote } from '../pages/customer-hub/quote-management/new-quote.page';
import { GLSetupPage } from '../pages/revenue-hub/configuration/glSetup.page';
import { GLAccountsPage } from '../pages/revenue-hub/configuration/glAccounts.page';
import { CurrencyPage } from '../pages/pricing-hub/Basic-configuration/currency.page';
import { TaxationPage } from '../pages/billing-hub/Bulk-operations/taxation.page';
import { ProductFamilyPage } from '../pages/pricing-hub/Basic-configuration/productFamily.page';
import { CreateOrderPage } from '../pages/customer-hub/order-management/create-order.page';
import { ServerHelper } from '../helpers/server-api.helper';
import { AccountOrderApiHelper } from '../helpers/account-order-api.helper';
import { TestLogger } from '../helpers/test-logger';
import { ToastComponent } from '../pages/components/toast.component';
import {
  loadTestContext,
  updateTestContext,
  saveTestContext,
  SavedContext
} from '../helpers/test-context.helper';
import { InvoicePage } from '../pages/billing-hub/Bulk-operations/invoices.page';

/**
 * All fixture types merged into a single test context.
 * This ensures cross-fixture dependencies (e.g. helpers needing testLogger)
 * are resolved correctly.
 */
type AllFixtures = {
  accountInfoPage: AccountInfoPage;
  accountOrderApiHelper: AccountOrderApiHelper;
  customerManagementPage: CustomerManagementPage;
  userManagementPage: UserManagementPage
  billsPage: BillsPage;
  dailySchedulePage: DailySchedulePage;
  databaseHelper: DatabaseHelper;
  jobScheduleDbHelper: JobScheduleDbHelper;
  loginPage: LoginPage;
  orderManagementPage: OrderManagementPage;
  reactSelect: (container: Locator) => ReactSelectComponent;
  screenshotHelper: ScreenshotHelper;
  searchAccountsPage: SearchAccountsPage;
  taskManagementPage: TaskManagementPage;
  serverHelper: ServerHelper;
  searchQuote: SearchQuote;
  newQuote: NewQuote;
  usagePage: UsagePage;
  contactPage: ContactPage;
  bundlePage: BundlePage;
  currencyPage: CurrencyPage;
  taxationPage: TaxationPage;
  gLAccountsPage: GLAccountsPage;
  gLSetupPage: GLSetupPage;
  paymentHistoryPage: PaymentHistoryPage;
  invoicePage: InvoicePage;
  corrspondencePage: CorrspondencePage;
  collectionPage: CollectionPage;
  productFamilyPage: ProductFamilyPage;
  createOrderPage: CreateOrderPage;
  servicesPage: ServicesPage;
  sidebar: SidebarComponent;
  table: (container: Locator) => TableComponent;
  testLogger: TestLogger;
  toast: ToastComponent;
  testContext: {
    load: () => SavedContext;
    update: (partial: Partial<SavedContext>) => void;
    save: (context: SavedContext) => void;
  };
};

export const test = base.extend<AllFixtures>({
  page: async ({ page }, use) => {
    page.navigateToHome = async () => {
      await page.goto(process.env.EMBRIX_BASE_URL ?? '/');
      await page.waitForLoadState('networkidle');
      const loader = page.locator('.animate__animated.animate__zoomIn');
      await loader.waitFor({ state: 'hidden', timeout: SHORT_WAIT }).catch(() => { });
    };

    page.waitForLoadingToDisappear = async () => {
      const loader = page.locator('.animate__animated.animate__zoomIn');
      // Wait up to 1s for the loader to appear (in case of transition delays)
      await loader.waitFor({ state: 'visible', timeout: SHORT_WAIT }).catch(() => { });
      // Wait for the loader to be hidden
      await loader.waitFor({ state: 'hidden', timeout: SHORT_WAIT }).catch(() => { });
    };

    await use(page);
  },

  // Logger
  testLogger: async ({ }, use, testInfo) => {
    const logger = new TestLogger(testInfo.title);
    await use(logger);
    logger.flush();
    await testInfo.attach('test-log', {
      path: logger.getFilePath(),
      contentType: 'text/plain',
    }).catch(() => { });
  },

  // Screenshot Helper — captures and attaches screenshots to the HTML report on demand
  screenshotHelper: async ({ page }, use, testInfo) => {
    const helper = new ScreenshotHelper(page, testInfo);
    await use(helper);
  },

  // Page Objects
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  searchAccountsPage: async ({ page }, use) => {
    await use(new SearchAccountsPage(page));
  },

  billsPage: async ({ page }, use) => {
    await use(new BillsPage(page));
  },

  productFamilyPage: async ({ page }, use) => {
    await use(new ProductFamilyPage(page));
  },

  bundlePage: async ({ page }, use) => {
    await use(new BundlePage(page));
  },

  contactPage: async ({ page }, use) => {
    await use(new ContactPage(page));
  },

  taskManagementPage: async ({ page }, use) => {
    await use(new TaskManagementPage(page));
  },

  userManagementPage: async ({ page }, use) => {
    await use(new UserManagementPage(page));
  },

  gLAccountsPage: async ({ page }, use) => {
    await use(new GLAccountsPage(page));
  },
  gLSetupPage: async ({ page }, use) => {
    await use(new GLSetupPage(page));
  },

  usagePage: async ({ page }, use) => {
    await use(new UsagePage(page));
  },

  corrspondencePage: async ({ page }, use) => {
    await use(new CorrspondencePage(page));
  },

  taxationPage: async ({ page }, use) => {
    await use(new TaxationPage(page));
  },
  paymentHistoryPage: async ({ page }, use) => {
    await use(new PaymentHistoryPage(page));
  },
  invoicePage: async ({ page }, use) => {
    await use(new InvoicePage(page));
  },


  collectionPage: async ({ page }, use) => {
    await use(new CollectionPage(page));
  },

  orderManagementPage: async ({ page }, use) => {
    await use(new OrderManagementPage(page));
  },

  accountInfoPage: async ({ page }, use) => {
    await use(new AccountInfoPage(page));
  },

  createOrderPage: async ({ page }, use) => {
    await use(new CreateOrderPage(page));
  },
  customerManagementPage: async ({ page }, use) => {
    await use(new CustomerManagementPage(page));
  },

  searchQuote: async ({ page }, use) => {
    await use(new SearchQuote(page));
  },


  currencyPage: async ({ page }, use) => {
    await use(new CurrencyPage(page));
  },

  newQuote: async ({ page }, use) => {
    await use(new NewQuote(page));
  },


  servicesPage: async ({ page }, use) => {
    await use(new ServicesPage(page));
  },

  dailySchedulePage: async ({ page }, use) => {
    await use(new DailySchedulePage(page));
  },

  /** Helpers (depend on testLogger) */
  serverHelper: async ({ request, testLogger }, use) => {
    await use(new ServerHelper(request, testLogger));
  },

  accountOrderApiHelper: async ({ request, testLogger }, use) => {
    await use(new AccountOrderApiHelper(request, testLogger));
  },

  databaseHelper: async ({ }, use) => {
    const databaseHelper = new DatabaseHelper();
    await use(databaseHelper);
  },

  jobScheduleDbHelper: async ({ }, use) => {
    const helper = new JobScheduleDbHelper();
    await use(helper);
  },

  sidebar: async ({ page }, use) => {
    await use(new SidebarComponent(page));
  },

  /** Components */
  toast: async ({ page }, use) => {
    await use(new ToastComponent(page));
  },

  reactSelect: async ({ page }, use) => {
    const factory = (container: Locator) => new ReactSelectComponent(page, container);
    await use(factory);
  },

  table: async ({ page }, use) => {
    const factory = (container: Locator) => new TableComponent(page, container);
    await use(factory);
  },

  /** Context Helper Fixture */
  testContext: async ({ }, use) => {
    await use({
      load: loadTestContext,
      update: updateTestContext,
      save: saveTestContext,
    });
  },
});

export { expect } from '@playwright/test';
