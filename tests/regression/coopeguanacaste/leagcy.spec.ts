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
  accountId: string;
  accountInfoPageUrl: string;
  billsPageUrl: string;
  servicesPageUrl: string;
  subscriptionId: string;
  gracePeriodInvoiceId: string;
  installationInvoiceId: string;

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

  test.only('TC-00: Suite Setup — Set CCP Time', async ({ serverHelper }) => {
    // Generate random dates for future testing period
    const testingDateObj = await serverHelper.generateRandomFutureDate();
    Object.assign(state, testingDateObj);
    await serverHelper.setAndVerifyCcpTime(state.startDate!);

    // Persist generated dates for subsequent tests in the suite
    updateTestContext({ testingDateObj });
  });

  test.only('TC-01: Residential Account Creation', async ({
    page, accountOrderApiHelper, testLogger, customerListingPage, servicesPage
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

    const servicesPageUrl = await servicesPage.navigateViaSideMenu();
    state.servicesPageUrl = servicesPageUrl;
    testLogger.data('Services Page URL', servicesPageUrl);
    updateTestContext({ servicesPageUrl });

  });

  test('TC-03: Successfully Provisioning An Order', async ({
    page, testLogger, screenshotHelper,
    orderListingPage, customerActivityPage, servicesPage, provisioningDbHelper,
  }) => {
    // Navigate to the Create New Order screen
    await orderListingPage.navigateViaNav();
    await orderListingPage.clickCreateNewOrder();

    // Search for the account created in TC-01
    await orderListingPage.searchAccountById(state.accountId!);
    const orderAcctNo = await orderListingPage.getFirstRowCellValue('ACCT No');
    expect(orderAcctNo).toBe(state.accountId);
    await orderListingPage.clickNextInFirstRow();

    // Input provisioning data dynamically
    // const randomHex = Math.random().toString(16).substring(2, 10).toUpperCase();
    // const uniqueProvisioningId = `ALCL${randomHex}`;
    await orderListingPage.selectReferenceOrder(state.orderId!);
    await orderListingPage.addProvisioningData();
    await orderListingPage.clickNextAboveSubscription();

    // Submit and capture resulting order ID
    await orderListingPage.clickCreate();
    const provisioningOrderUrl = await orderListingPage.isProvisioningOrderSuccessfulToastAppear(screenshotHelper);
    const provisioningOrderId = provisioningOrderUrl.match(/orders\/(ORD-\d+)\//)?.[1] ?? '';
    state.provisioningOrderUrl = provisioningOrderUrl;
    state.provisioningOrderId = provisioningOrderId;
    testLogger.data('Provisioning Order URL', provisioningOrderUrl);
    testLogger.data('Provisioning Order ID', provisioningOrderId);

    // Persist provisioning order details for next test
    updateTestContext({ provisioningOrderUrl, provisioningOrderId });

    // Verify provisioning order status - Provisioning Initiated
    await page.navigate(state.accountInfoPageUrl!)
    const servicesPageUrl = await servicesPage.navigateViaSideMenu();
    state.servicesPageUrl = servicesPageUrl;
    testLogger.data('Services Page URL', servicesPageUrl);
    updateTestContext({ servicesPageUrl });

    await servicesPage.isOrderAppearInIncompleteTableWithStatus(state.orderId!, "CREATED")
    testLogger.log('In-Complete Orders ID verified: ' + state.orderId);
    await servicesPage.isOrderAppearInIncompleteTableWithStatus(state.orderId!, "PROVISIONING_INITIATED")
    testLogger.log('Provisioning order status verified: PROVISIONING_INITIATED')

    /**
     * Verify Provisioning Status - FINALIZADO
     */
    await page.navigate(state.accountInfoPageUrl!)
    await customerActivityPage.navigateViaSideMenu();
    await customerActivityPage.clickClearButton();
    const requestContent = await customerActivityPage.waitForActivityRequestContent(
      'UPDATE_WORK_ORDER',
      [
        '"status": "FINALIZADO"',
        `"orderId": "${state.provisioningOrderId}"`,
        `"accountId": "${state.accountId}"`
      ],
      testLogger
    );
    testLogger.log('UPDATE_WORK_ORDER details verified: ' + requestContent);
  });

  test('TC-05: Recurring Billing Month 01', async ({
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
    await page.navigate(state.billsPageUrl!);

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

  test('TC-06: Recurring Billing Month 02', async ({
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
     * Verify Recurring Invoice for month 02
     */
    await page.navigate(state.billsPageUrl!);

    // Verify the new invoice in the Open/Closed Bills list
    const expectedRecurringInvoiceMonth02Details = {
      billType: 'REGULAR',
      startDate: state.nextTwoMonthsFirstDate,
      endDate: state.nextThreeMonthsFirstDate,
      invoiceDate: state.nextThreeMonthsFirstDate,
      total: EXPECTED_INVOICE_AMOUNT,
      invoiceStatus: 'ACTIVE',
    };
    testLogger.data('Expected Recurring Invoice Month 02 Details: ', expectedRecurringInvoiceMonth02Details);
    const verifiedMonth02Details = await billsPage.verifyOpenClosedInvoiceRow(expectedRecurringInvoiceMonth02Details);
    const recurringMonth02InvoiceId = verifiedMonth02Details.invoiceId!;
    const recurringMonth02BillUnitId = verifiedMonth02Details.billUnitId!;

    // Persist Grace Period invoice details for next test
    updateTestContext({
      recurringMonth02InvoiceId,
      recurringMonth02BillUnitId,
      recurringMonth02InvoiceDetails: verifiedMonth02Details
    });

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

  test('TC-07: Collection Notification Month 02', async ({
    page, testLogger, billsPage, dailySchedulePage
  }) => {
    // Load recurring month 02 details
    const recurringMonth02InvoiceDetails = state.recurringMonth02InvoiceDetails!;
    const expectedRecurringInvoiceMonth02Details = {
      ...recurringMonth02InvoiceDetails,
      invoiceStatus: 'COLLECTION',
    };

    /**
     * Verify Recurring Invoice for month 02 should still have status COLLECTION on 16th
     */
    const nextTwoMonthsSixteenth = state.nextTwoMonthsSixteenth!;
    await dailySchedulePage.createAndRunJobsForDate(nextTwoMonthsSixteenth);
    await page.navigateToHome();
    await page.navigate(state.billsPageUrl!);
    testLogger.data('Recurring Invoice Month 02 Details on 16th: ', expectedRecurringInvoiceMonth02Details);
    await billsPage.verifyOpenClosedInvoiceRow(expectedRecurringInvoiceMonth02Details);

    /**
     * Verify Recurring Invoice for month 02 should still have status COLLECTION on 17th
     */
    const nextTwoMonthsSeventeenth = state.nextTwoMonthsSeventeenth!;
    await dailySchedulePage.createAndRunJobsForDate(nextTwoMonthsSeventeenth);
    await page.navigateToHome();
    await page.navigate(state.billsPageUrl!);
    testLogger.data('Recurring Invoice Month 02 Details on 17th: ', expectedRecurringInvoiceMonth02Details);
    await billsPage.verifyOpenClosedInvoiceRow(expectedRecurringInvoiceMonth02Details);
    // TODO: After 17th, an email will be sent to the customer, will verify when email system works

    /**
     * Verify the subscription is suspended after 21th
     */
    const nextTwoMonthsTwentyFirst = state.nextTwoMonthsTwentyFirst!;
    await dailySchedulePage.createAndRunJobsForDate(nextTwoMonthsTwentyFirst);
    await page.navigate(state.servicesPageUrl!);

  })

});
