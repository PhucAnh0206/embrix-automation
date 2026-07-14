import { test as base } from '@playwright/test';
import { Page, Locator } from '@playwright/test';
import { MEDIUM_WAIT, SHORT_WAIT } from '../helpers/timeouts.helper';

/** Page extensions */
declare module '@playwright/test' {
  // Extended Page type with custom methods
  interface Page {
    navigate(url: string): Promise<void>;
    navigateToHome(): Promise<void>;
    waitForLoadingToDisappear(): Promise<void>;
  }
}

/** Page objects */
import { CustomerActivityPage } from '../pages/customer-hub/customer-management/account-details/account-data/customer-activity.page'
import { BillsPage } from '../pages/customer-hub/customer-management/account-details/billing-data/bills.page';
import { DailySchedulePage } from '../pages/operations-hub/jobs-management/daily-schedule.page';
import { LoginPage } from '../pages/login.page';
import { OrderListingPage } from '../pages/customer-hub/order-management/order/order-listing.page';
import { CustomerListingPage } from '../pages/customer-hub/customer-management/customer-listing.page';
import { ServicesPage } from '../pages/customer-hub/customer-management/account-details/subscription-data/services.page';
import { OrderDetailsPage } from '../pages/customer-hub/order-management/order/order-details.page';

/** Common component helpers */
import { ReactSelectComponent } from '../pages/components/react-select.component';
import { SidebarComponent } from '../pages/components/sidebar.component';
import { TableComponent } from '../pages/components/table.component';
import { ToastComponent } from '../pages/components/toast.component';

/** API helpers */
import { ServerHelper } from '../helpers/server-api.helper';
import { AccountOrderApiHelper } from '../helpers/account-order-api.helper';

/** Database helpers */
import { DatabaseHelper } from '../helpers/database.helper';
import { JobScheduleDbHelper } from '../helpers/db/job-schedule.db';
import { ProvisioningDbHelper } from '../helpers/db/provisioning.db';

/** Utils helpers */
import { ScreenshotHelper } from '../helpers/screenshot.helper';
import { TestLogger } from '../helpers/test-logger';
import {
  loadTestContext,
  updateTestContext,
  saveTestContext,
  SavedContext
} from '../helpers/test-context.helper';

/** Custom type: AllFixtures
 * All fixture types merged into a single test context.
 * This ensures cross-fixture dependencies (e.g. helpers needing testLogger)
 * are resolved correctly.
 */
type AllFixtures = {
  // Page objects
  customerActivityPage: CustomerActivityPage;
  billsPage: BillsPage;
  dailySchedulePage: DailySchedulePage;
  loginPage: LoginPage;
  orderListingPage: OrderListingPage;
  customerListingPage: CustomerListingPage;
  servicesPage: ServicesPage;
  orderDetailsPage: OrderDetailsPage;

  // Components
  reactSelect: (container: Locator) => ReactSelectComponent;
  sidebar: SidebarComponent;
  table: (container: Locator) => TableComponent;
  toast: ToastComponent;

  // Workflows
  rerunDailyScheduleFlow: (date: string) => Promise<void>;

  // APIs
  accountOrderApiHelper: AccountOrderApiHelper;
  serverHelper: ServerHelper;

  // Database
  databaseHelper: DatabaseHelper;
  jobScheduleDbHelper: JobScheduleDbHelper;
  provisioningDbHelper: ProvisioningDbHelper;

  // Utils
  screenshotHelper: ScreenshotHelper;
  testLogger: TestLogger;
  testContext: {
    load: () => SavedContext;
    update: (partial: Partial<SavedContext>) => void;
    save: (context: SavedContext) => void;
  };
};

export const test = base.extend<AllFixtures>({
  page: async ({ page }, use) => {

    /** Navigate to a path relative to baseURL, wait for network idle. */
    page.navigate = async (path: string) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.waitForLoadingToDisappear();
    };

    /** Navigate to the home page */
    page.navigateToHome = async () => {
      await page.goto(process.env.EMBRIX_BASE_URL ?? '/');
      await page.waitForLoadState('networkidle');
      await page.waitForLoadingToDisappear()
    };

    /** Wait for loading animation to disappear */
    page.waitForLoadingToDisappear = async () => {
      const loader = page.locator('.animate__animated.animate__zoomIn');
      // Wait at most SHORT_WAIT (1s) for loader to appear. If it doesn't show up, skip waiting for it.
      await loader.waitFor({ state: 'visible', timeout: SHORT_WAIT }).catch(() => { });
      if (await loader.isVisible()) {
        await loader.waitFor({ state: 'hidden', timeout: MEDIUM_WAIT }).catch(() => { });
      }
    };

    await use(page);
  },


  /** 
   * Fixtures
   */

  /** Page objects fixtures */
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  customerListingPage: async ({ page }, use) => {
    await use(new CustomerListingPage(page));
  },

  billsPage: async ({ page, testLogger }, use) => {
    await use(new BillsPage(page, testLogger));
  },

  orderListingPage: async ({ page }, use) => {
    await use(new OrderListingPage(page));
  },

  customerActivityPage: async ({ page }, use) => {
    await use(new CustomerActivityPage(page));
  },

  servicesPage: async ({ page }, use) => {
    await use(new ServicesPage(page));
  },

  dailySchedulePage: async ({ page, testLogger, serverHelper, jobScheduleDbHelper }, use) => {
    await use(new DailySchedulePage(page, testLogger, serverHelper, jobScheduleDbHelper));
  },

  orderDetailsPage: async ({ page, testLogger }, use) => {
    await use(new OrderDetailsPage(page, testLogger));
  },

  /** Components fixtures*/
  reactSelect: async ({ page }, use) => {
    const factory = (container: Locator) => new ReactSelectComponent(page, container);
    await use(factory);
  },

  sidebar: async ({ page }, use) => {
    await use(new SidebarComponent(page));
  },

  table: async ({ page }, use) => {
    const factory = (container: Locator) => new TableComponent(page, container);
    await use(factory);
  },

  toast: async ({ page }, use) => {
    await use(new ToastComponent(page));
  },

  /** APIs fixtures */
  serverHelper: async ({ request, testLogger }, use) => {
    await use(new ServerHelper(request, testLogger));
  },

  accountOrderApiHelper: async ({ request, testLogger }, use) => {
    await use(new AccountOrderApiHelper(request, testLogger));
  },

  /** Database fixtures */
  databaseHelper: async ({ }, use) => {
    const databaseHelper = new DatabaseHelper();
    await use(databaseHelper);
  },

  jobScheduleDbHelper: async ({ }, use) => {
    const helper = new JobScheduleDbHelper();
    await use(helper);
  },

  provisioningDbHelper: async ({ }, use) => {
    const helper = new ProvisioningDbHelper();
    await use(helper);
  },
  /** Utils Fixtures */
  screenshotHelper: async ({ page }, use, testInfo) => {
    const helper = new ScreenshotHelper(page, testInfo);
    await use(helper);
  },

  testLogger: async ({ }, use, testInfo) => {
    const logger = new TestLogger(testInfo.title);
    await use(logger);
    logger.flush();
    await testInfo.attach('test-log', {
      path: logger.getFilePath(),
      contentType: 'text/plain',
    })
  },

  testContext: async ({ }, use) => {
    await use({
      load: loadTestContext,
      update: updateTestContext,
      save: saveTestContext,
    });
  },


});

export { expect } from '@playwright/test';
