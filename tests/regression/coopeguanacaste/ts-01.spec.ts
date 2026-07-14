/**
 * Tags: @regression
 * Tags: @coopeguanacaste
 *
 * Serial test suite: each TC depends on data created by the previous one.
 * Shared state is held in a mutable object at suite level and also persisted
 * to `playwright/.auth/test-context.json` via `updateTestContext()`.
 */

import { test, expect } from '../../../fixtures/page-factory';
import { updateTestContext, loadTestContext } from '../../../helpers/test-context.helper';
import { InvoiceParams } from '../../../pages/customer-hub/customer-management/account-details/billing-data/bills.page';

// Shared mutable state across serial tests
interface SuiteState {
  startDate: string;
  nextMonthFirstDate: string;
  nextTwoMonthsFirstDate: string;
  nextThreeMonthsFirstDate: string;
  nextFourMonthsFirstDate: string;
  nextFiveMonthsFirstDate: string;
  nextSixMonthsFirstDate: string;
  nextTwoMonthsSixteenth: string;
  nextTwoMonthsSeventeenth: string;
  nextTwoMonthsTwentyFirst: string;

  accountId: string;
  accountInfoPageUrl: string;
  billsPageUrl: string;
  servicesPageUrl: string;
  orderDetailsPageUrl: string;
  subscriptionId: string;

  orderId: string;
  provisioningOrderId: string;
  provisioningOrderUrl: string;
  recurringMonth01InvoiceId: string;
  recurringMonth02InvoiceId: string;
  recurringMonth02BillUnitId: string;
  recurringMonth03InvoiceId: string;
  recurringMonth04InvoiceId: string;
  recurringMonth05InvoiceId: string;

  installationInvoiceDetails: InvoiceParams;
  gracePeriodInvoiceDetails?: InvoiceParams;
  recurringMonth01InvoiceDetails?: InvoiceParams;
  recurringMonth02InvoiceDetails?: InvoiceParams;
}

const state: Partial<SuiteState> = {};
const EXPECTED_INVOICE_AMOUNT = '19,273.67';

test.describe.serial('REGRESSION - TS-01: Full flow Account Creation & Orders, Provision Order, Installation Invoice & Recurring Invoices', { tag: ['@regression', '@coopeguanacaste'] }, () => {

  test.beforeEach(async () => {
    // Restore shared state from test-context.json if we are running isolated tests
    try {
      const saved = loadTestContext();
      for (const [key, value] of Object.entries(saved)) {
        if (key === 'testingDateObj' && value) {
          for (const [dateKey, dateValue] of Object.entries(value)) {
            (state as any)[dateKey] = (state as any)[dateKey] ?? dateValue;
          }
        } else {
          (state as any)[key] = (state as any)[key] ?? value;
        }
      }
    } catch {
      // Ignored: context file might not exist on the first run of the suite
    }
  });

  test('TC-00: Suite Setup — Set CCP Time', async ({ serverHelper }) => {
    // Generate random dates for future testing period
    const testingDateObj = await serverHelper.generateRandomFutureDate();
    Object.assign(state, testingDateObj);
    await serverHelper.setAndVerifyCcpTime(state.startDate!);

    // Persist generated dates for subsequent tests in the suite
    updateTestContext({ testingDateObj });
  });

  test('TC-01: Residential Account Creation', async ({
    accountOrderApiHelper,
    testLogger,
    customerListingPage
  }) => {
    // Navigate to Customer Management to search for a unique, non-existent Account ID
    await customerListingPage.navigateViaNav();

    // Find a unique, non-existent Account ID and Order ID
    const { accountId: uniqueAccountId, orderId: uniqueOrderId } = await customerListingPage.generateUniqueAccountAndOrderId('AC', 'OR');
    testLogger.log(`Found unique Account ID: ${uniqueAccountId}`);

    // Create the account using the verified unique IDs
    const { accountId, orderId } = await accountOrderApiHelper.createAccountAndOrder(
      { accountId: uniqueAccountId, orderId: uniqueOrderId },
      'Create simple Residental account with simple services',
      'RESIDENTIAL_DEFAULT',
    );
    state.accountId = accountId;
    state.orderId = orderId;
    testLogger.data('accountId', accountId);
    testLogger.data('orderId', orderId);

    // Verify the created account appears in the UI
    await customerListingPage.navigateViaNav();
    await customerListingPage.searchByAccountId(accountId);
    const acctNo = await customerListingPage.getFirstRowCellValue('ACCT No');
    expect(acctNo).toBe(accountId);

    // Navigate into the account detail
    const accountInfoPageUrl = await customerListingPage.clickFirstRowLink('ACCT No');
    state.accountInfoPageUrl = accountInfoPageUrl;
    testLogger.data('Account Info URL', accountInfoPageUrl);
    updateTestContext({ accountInfoPageUrl });


  });

  test('TC-02: Successfully Provisioning An Order', async ({
    page,
    request,
    testLogger,
    screenshotHelper,
    provisioningDbHelper,
    servicesPage,
    orderDetailsPage

  }) => {
    // Navigate to Services page
    await page.navigate(state.accountInfoPageUrl!)
    await servicesPage.navigateViaSideMenu()
    state.servicesPageUrl = page.url();
    testLogger.data('Services Page URL', state.servicesPageUrl);
    updateTestContext({ servicesPageUrl: state.servicesPageUrl });

    // Verify the created order should be in the Imcompleted Order list
    await servicesPage.isOrderAppearInIncompleteTableWithStatus(state.orderId!, "CREATED")
    testLogger.log(`Order status before adding provisioning data: CREATED`);

    // Bypass provisioning process via DB
    await provisioningDbHelper.bypassProvisioning(request, state.accountId!, state.orderId!, testLogger)

    // Verify order is no longer in incomplete orders list
    await page.navigate(state.servicesPageUrl!)
    const isRowVisible = await servicesPage.incompleteOrdersTable.rows.filter({ hasText: state.orderId! }).first().isVisible();
    expect(isRowVisible).toBeFalsy();
    testLogger.log('Verified order is no longer in In-Complete Orders.');
  });

  test('TC-03: Recurring Billing Month 01', async ({
    page, testLogger, billsPage, dailySchedulePage
  }) => {
    /**
     * Rerun daily schedule jobs for next two months first date
     */
    const dateObject = {
      firstDate: state.nextMonthFirstDate!
    }
    await dailySchedulePage.repareJobsForEachMonth(dateObject)

    /**
     * Verify Recurring Invoice for month 01
     */
    // Navigate to Bills page
    await page.navigate(state.accountInfoPageUrl!)
    await billsPage.navigateViaSideMenu()
    state.billsPageUrl = page.url();
    testLogger.data('Bills Page URL', state.billsPageUrl);
    updateTestContext({ billsPageUrl: state.billsPageUrl });

    // Verify the new invoice in the Open/Closed Bills list
    const expectedRecurringInvoiceMonth01Details = {
      billType: 'REGULAR',
      startDate: state.nextMonthFirstDate,
      endDate: state.nextTwoMonthsFirstDate,
      total: '0'
    };
    testLogger.data('Expected Recurring Invoice Month 01 Details: ', expectedRecurringInvoiceMonth01Details);
    const verifiedMonth01Details = await billsPage.verifyOpenClosedInvoiceRow(expectedRecurringInvoiceMonth01Details);
    const recurringMonth01InvoiceId = verifiedMonth01Details.invoiceId!;

    // Persist Grace Period invoice details for next test
    updateTestContext({ recurringMonth01InvoiceId, recurringMonth01InvoiceDetails: expectedRecurringInvoiceMonth01Details });

    // Verify the new invoice in the Pending Bills list
    const expectedPendingInvoiceDetails = {
      startDate: state.nextTwoMonthsFirstDate,
      endDate: state.nextThreeMonthsFirstDate,
      total: '0',
      invoiceStatus: 'PENDING',
    };
    testLogger.data('Expected New Pending Invoice Details: ', expectedPendingInvoiceDetails);
    await billsPage.verifyPendingInvoiceRow(expectedPendingInvoiceDetails);
  });

  test('TC-04: Recurring Billing Month 02', async ({
    page, testLogger, billsPage, dailySchedulePage
  }) => {
    /**
     * Rerun daily schedule jobs for next two months first date
     */
    const dateObject = {
      firstDate: state.nextTwoMonthsFirstDate!
    }
    await dailySchedulePage.repareJobsForEachMonth(dateObject)

    /**
     * Verify Recurring Invoice for month 01
     */
    // Navigate to Bills page
    await page.navigate(state.accountInfoPageUrl!)
    await billsPage.navigateViaSideMenu()
    state.billsPageUrl = page.url();
    testLogger.data('Bills Page URL', state.billsPageUrl);
    updateTestContext({ billsPageUrl: state.billsPageUrl });

    // Verify the new invoice in the Open/Closed Bills list
    const expectedRecurringInvoiceMonth02Details = {
      billType: 'REGULAR',
      startDate: state.nextTwoMonthsFirstDate,
      endDate: state.nextThreeMonthsFirstDate,
      total: '0'
    };
    testLogger.data('Expected Recurring Invoice Month 02 Details: ', expectedRecurringInvoiceMonth02Details);
    const verifiedMonth02Details = await billsPage.verifyOpenClosedInvoiceRow(expectedRecurringInvoiceMonth02Details);
    const recurringMonth02InvoiceId = verifiedMonth02Details.invoiceId!;

    // Persist Grace Period invoice details for next test
    updateTestContext({ recurringMonth02InvoiceId, recurringMonth02InvoiceDetails: expectedRecurringInvoiceMonth02Details });

    // Verify the new invoice in the Pending Bills list
    const expectedPendingInvoiceDetails = {
      startDate: state.nextThreeMonthsFirstDate,
      endDate: state.nextFourMonthsFirstDate,
      total: '0',
      invoiceStatus: 'PENDING',
    };
    testLogger.data('Expected New Pending Invoice Details: ', expectedPendingInvoiceDetails);
    await billsPage.verifyPendingInvoiceRow(expectedPendingInvoiceDetails);
  });
});
