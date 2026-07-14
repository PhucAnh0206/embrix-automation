/**
 * Tags: @regression
 * Tags: @coopeguanacaste
 *
 * Serial test suite: each TC depends on data created by the previous one.
 * Shared state is held in a mutable object at suite level and also persisted
 * to `playwright/.auth/test-context.json` via `updateTestContext()`.
 */

import { test, expect } from '../../../fixtures/page-factory';
import { MEDIUM_WAIT } from '../../../helpers/timeouts.helper';
import { updateTestContext, loadTestContext } from '../../../helpers/test-context.helper';

// Shared mutable state across serial tests
interface SuiteState {
  startDate: string;
  nextMonthFirstDate: string;
  nextTwoMonthsFirstDate: string;
  nextThreeMonthsFirstDate: string;
  nextFourMonthsFirstDate: string;
  nextFiveMonthsFirstDate: string;
  accountId: string;
  orderId: string;
  accountInfoPageUrl: string;
  billsPageUrl: string;
  invoiceId: string;
  totalAmount: string;
  provisioningOrderId: string;
  provisioningOrderUrl: string;
}

const state: Partial<SuiteState> = {};

test.describe.serial('REGRESSION - TS-01: Full flow Account Creation & Orders, Provision Order, Installation Invoice & Recurring Invoices', { tag: ['@regression', '@coopeguanacaste'] }, () => {

  test.beforeEach(async () => {
    // Restore shared state from test-context.json if we are running isolated tests
    try {
      const saved = loadTestContext();
      if (saved.testingDateObj) {
        state.startDate = state.startDate ?? saved.testingDateObj.startDate;
        state.nextMonthFirstDate = state.nextMonthFirstDate ?? saved.testingDateObj.nextMonthFirstDate;
        state.nextTwoMonthsFirstDate = state.nextTwoMonthsFirstDate ?? saved.testingDateObj.nextTwoMonthsFirstDate;
        state.nextThreeMonthsFirstDate = state.nextThreeMonthsFirstDate ?? saved.testingDateObj.nextThreeMonthsFirstDate;
        state.nextFourMonthsFirstDate = state.nextFourMonthsFirstDate ?? saved.testingDateObj.nextFourMonthsFirstDate;
        state.nextFiveMonthsFirstDate = state.nextFiveMonthsFirstDate ?? saved.testingDateObj.nextFiveMonthsFirstDate;
      }
      state.accountId = state.accountId ?? saved.accountId;
      state.orderId = state.orderId ?? saved.orderId;
      state.accountInfoPageUrl = state.accountInfoPageUrl ?? saved.accountInfoPageUrl;
      state.billsPageUrl = state.billsPageUrl ?? saved.billsPageUrl;
      state.invoiceId = state.invoiceId ?? saved.invoiceId;
      state.totalAmount = state.totalAmount ?? saved.totalAmount;
      state.provisioningOrderId = state.provisioningOrderId ?? saved.provisioningOrderId;
      state.provisioningOrderUrl = state.provisioningOrderUrl ?? saved.provisioningOrderUrl;
    } catch {
      // Ignored: context file might not exist on the first run of the suite
    }
  });

  test('TC-00: Suite Setup — Set CCP Time', async ({ serverHelper }) => {
    // Generate random dates for future testing period
    const testingDateObj = await serverHelper.generateRandomFutureDate();
    state.startDate = testingDateObj.startDate; // Date for creating account, order and first invoice
    state.nextMonthFirstDate = testingDateObj.nextMonthFirstDate; // Date for next month's jobs
    state.nextTwoMonthsFirstDate = testingDateObj.nextTwoMonthsFirstDate; // Date for two months ahead's jobs
    state.nextThreeMonthsFirstDate = testingDateObj.nextThreeMonthsFirstDate; // Date for three months ahead's jobs
    state.nextFourMonthsFirstDate = testingDateObj.nextFourMonthsFirstDate; // Date for four months ahead's jobs
    state.nextFiveMonthsFirstDate = testingDateObj.nextFiveMonthsFirstDate; // Date for five months ahead's jobs

    await serverHelper.setAndVerifyCcpTime(state.startDate); // Set date for create account, order and first invoice

    // Persist generated dates for other tests in suite
    updateTestContext({
      testingDateObj: {
        startDate: state.startDate,
        nextMonthFirstDate: state.nextMonthFirstDate,
        nextTwoMonthsFirstDate: state.nextTwoMonthsFirstDate,
        nextThreeMonthsFirstDate: state.nextThreeMonthsFirstDate,
        nextFourMonthsFirstDate: state.nextFourMonthsFirstDate,
        nextFiveMonthsFirstDate: state.nextFiveMonthsFirstDate,
      },
    });
  });

  test('TC-01: Residential Account Creation', async ({
    page, accountOrderApiHelper, testLogger, searchAccountsPage,
  }) => {
    // Navigate to Customer Management to search for a unique, non-existent Account ID
    await page.navigateToHome();
    await searchAccountsPage.navigateViaNav();

    let uniqueAccountId = '';
    let uniqueOrderId = '';
    let isUnique = false;

    while (!isUnique) {
      const randomSuffix = Math.floor(100000 + Math.random() * 900000);
      const testId = `AC-${randomSuffix}`;

      // Search for the generated test ID
      const accountIdInput = page.locator("//input[@name='accountId']").first();
      await accountIdInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
      await accountIdInput.fill(testId);
      await page.getByRole('button', { name: 'Search', exact: true }).click();

      await page.waitForLoadingToDisappear();
      await page.waitForLoadState('networkidle');

      // Check if the row with this Account ID is visible (isVisible is instant and doesn't wait)
      const row = searchAccountsPage.table.rows.filter({ hasText: testId }).first();
      const exists = await row.isVisible();

      if (!exists) {
        uniqueAccountId = testId;
        uniqueOrderId = `OR-${randomSuffix}`;
        isUnique = true;
        testLogger.log(`Found unique Account ID: ${uniqueAccountId}`);
      } else {
        testLogger.log(`Account ID ${testId} already exists in the system. Regenerating...`);
      }
    }

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
    await page.navigateToHome();
    await searchAccountsPage.navigateViaNav();
    await searchAccountsPage.searchByAccountId(accountId);
    const acctNo = await searchAccountsPage.getFirstRowCellValue('ACCT No');
    expect(acctNo).toBe(accountId);

    // Navigate into the account detail
    const accountInfoPageUrl = await searchAccountsPage.clickFirstRowLink('ACCT No');
    state.accountInfoPageUrl = accountInfoPageUrl;
    testLogger.data('Account Info URL', accountInfoPageUrl);
    updateTestContext({ accountInfoPageUrl });
  });

  test('TC-02: Installation Invoice Payment', async ({
    page, accountOrderApiHelper, testLogger, billsPage,
  }) => {
    // Navigate into the account detail
    await page.goto(state.accountInfoPageUrl!);
    const billsPageUrl = await billsPage.navigateViaSideMenu();
    state.billsPageUrl = billsPageUrl;
    testLogger.data('Bills Page URL', billsPageUrl);
    updateTestContext({ billsPageUrl });

    // Read first-row billing details
    const billType = await billsPage.getFirstRowCellValue('Bill Type');
    const billStartDate = await billsPage.getFirstRowCellValue('Start Date');
    const billEndDate = await billsPage.getFirstRowCellValue('End Date');
    const totalAmount = await billsPage.getFirstRowCellValue('Total');
    const invoiceId = await billsPage.getFirstRowCellValue('Invoice Id');
    const invoiceDate = await billsPage.getFirstRowCellValue('Invoice Date');
    const invoiceStatus = await billsPage.getFirstRowCellValue('Invoice Status');

    state.invoiceId = invoiceId;
    state.totalAmount = totalAmount;
    testLogger.data('Bill Details', {
      billType, billStartDate, billEndDate, totalAmount,
      invoiceId, invoiceDate, invoiceStatus,
    });
    // Persist invoice details for next test
    updateTestContext({ invoiceId, totalAmount });

    // Assert installation invoice values
    expect(billType).toBe('ONE_TIME');
    expect(billStartDate).toBe(state.startDate);
    expect(billEndDate).toBe(state.startDate);
    expect(totalAmount).toBe('19,273.67');
    expect(invoiceDate).toBe(state.startDate);
    expect(invoiceStatus).toBe('ACTIVE');

    // Pay the invoice via API
    await accountOrderApiHelper.payInvoice(state.accountId!, invoiceId, totalAmount);

    // Verify status changed to CLOSED
    await page.goto(billsPageUrl);
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.waitForLoadingToDisappear();
    const row = billsPage.table.rows.filter({ hasText: invoiceId }).first();
    await row.waitFor({ state: 'visible', timeout: MEDIUM_WAIT }).catch(() => { });
    const updatedInvoiceStatus = await billsPage.getRowCellValueByInvoiceId(invoiceId, 'Invoice Status');
    expect(updatedInvoiceStatus).toBe('CLOSED');
  });

  test('TC-03: Successfully Provisioning An Order', async ({
    page, testLogger, screenshotHelper,
    orderManagementPage, accountInfoPage, servicesPage,
  }) => {
    // Navigate to the Create New Order screen
    await page.navigateToHome();
    await orderManagementPage.navigateViaNav();
    await orderManagementPage.clickCreateNewOrder();

    // Search for the account created in TC-01
    await orderManagementPage.searchAccountById(state.accountId!);
    const orderAcctNo = await orderManagementPage.getFirstRowCellValue('ACCT No');
    expect(orderAcctNo).toBe(state.accountId);
    await orderManagementPage.clickNextInFirstRow();

    // Input provisioning data from test-data/provisioning.data.json file
    await orderManagementPage.selectReferenceOrder(state.orderId!);
    await orderManagementPage.addProvisioningData();
    await orderManagementPage.clickNextAboveSubscription();

    // Submit and capture resulting order ID
    await orderManagementPage.clickCreate();
    const provisioningOrderUrl = await orderManagementPage.isProvisioningOrderSuccessfulToastAppear(screenshotHelper);
    const provisioningOrderId = provisioningOrderUrl.match(/orders\/(ORD-\d+)\//)?.[1] ?? '';

    state.provisioningOrderUrl = provisioningOrderUrl;
    state.provisioningOrderId = provisioningOrderId;
    testLogger.data('Provisioning Order URL', provisioningOrderUrl);
    testLogger.data('Provisioning Order ID', provisioningOrderId);
    // Persist provisioning order details for next test
    updateTestContext({ provisioningOrderUrl, provisioningOrderId });

    // Verify provisioning order status - Provisioning Initiated
    await page.goto(state.accountInfoPageUrl!);
    await page.waitForLoadState('networkidle').catch(() => { });
    await servicesPage.navigateViaSideMenu();
    const incompleteOrderId = await servicesPage.getInCompleteOrdersFirstRowCellValue('Id');
    expect(incompleteOrderId).toBe(provisioningOrderId);
    testLogger.log('In-Complete Orders ID verified: ' + incompleteOrderId);
    const provisioningStatus = await servicesPage.getInCompleteOrdersFirstRowCellValue('Status');
    expect(provisioningStatus).toMatch(/PROVISIONING_INITIATED|Provisioning Initiated/i);
    testLogger.log('Provisioning order status verified: ' + provisioningStatus);

    // Verify provisioning order request content in Customer Activities list
    await page.goto(state.accountInfoPageUrl!);
    await page.waitForLoadState('networkidle')
    await accountInfoPage.navigateToCustomerActivity();
    await accountInfoPage.clickClearButton(); // clear default date filter to get all logs

    // Verify provisioning request content in UPDATE_WORK_ORDER activity log
    const requestContent = await accountInfoPage.waitForActivityRequestContent(
      'UPDATE_WORK_ORDER',
      [
        '"status": "FINALIZADO"',
        `"orderId": "${state.provisioningOrderId}"`,
        `"accountId": "${state.accountId}"`
      ],
      testLogger
    );
    // Persist request content for other tests
    updateTestContext({ requestContent });
  });

  test('TC-04: Grace Period Billing', async ({
    page, testLogger, screenshotHelper, toast,
    serverHelper,
    dailySchedulePage,
    jobScheduleDbHelper,
    billsPage
  }) => {
    // Set next month first date for billing
    const date = state.nextMonthFirstDate!;
    await serverHelper.setAndVerifyCcpTime(date);
    testLogger.data('Grace Period Billing Date', date);

    // Navigate to Jobs Schedule screen
    await page.navigateToHome();
    await dailySchedulePage.navigateViaNav();

    // Input the target date into the calendar
    await dailySchedulePage.inputJobCalendar(date);

    // If jobs list for that date already exists, clear it via DB helper
    await dailySchedulePage.clearExistingJobSchedule(jobScheduleDbHelper, date, testLogger);

    // Verify cleanup — use DB helper to confirm deletion
    try {
      const remainingJobs = await jobScheduleDbHelper.getJobSchedule(date);
      testLogger.data('Remaining jobs after cleanup', remainingJobs);
      expect(remainingJobs.length).toBe(0);
      testLogger.log('DB cleanup verified: no remaining job schedules.');
    } catch (error) {
      testLogger.error('DB cleanup verification failed', String(error));
    }

    // Click Create Job Schedule button, expect a success toast
    await dailySchedulePage.clickCreateJobSchedule();
    await toast.expectSuccess();
    testLogger.log('Job Schedule created successfully.');

    // Wait for job cards list to appear on the UI
    const jobListVisible = await dailySchedulePage.isJobListVisible();
    expect(jobListVisible).toBeTruthy();
    testLogger.log('Job cards are now visible on the UI.');

    // Click on Process button
    await dailySchedulePage.clickProcess();

    // Click Yes on confirmation modal, expect a success toast
    await dailySchedulePage.confirmProcess();
    await toast.expectSuccess();
    testLogger.log('Process confirmed and started.');

    // Poll for all jobs to complete (max 10 retries with refresh)
    const allCompleted = await dailySchedulePage.waitForAllJobsCompleted(testLogger);
    expect(allCompleted).toBeTruthy();
    testLogger.log('All job cards have completed processing.');

    await screenshotHelper.captureAndAttach('TC-04-all-jobs-completed');

    // Navigate to the Bills list
    await page.goto(state.billsPageUrl!);
    await page.waitForLoadState('networkidle').catch(() => { });

    // Verify the new invoice in the Open/Closed Bills list
    const billType = await billsPage.table.getFirstRowCellValue('Bill Type');
    const billStartDate = await billsPage.table.getFirstRowCellValue('Start Date');
    const billEndDate = await billsPage.table.getFirstRowCellValue('End Date');
    const totalAmount = await billsPage.table.getFirstRowCellValue('Total');

    expect(billType).toBe('REGULAR');
    expect(billStartDate).toBe(state.startDate);
    expect(billEndDate).toBe(state.nextMonthFirstDate);
    expect(totalAmount).toBe('0');

    // Verify the first record in the Pending Bills list
    const pendingBillStartDate = await billsPage.pendingBillsTable.getFirstRowCellValue('Start Date');
    const pendingBillEndDate = await billsPage.pendingBillsTable.getFirstRowCellValue('End Date');
    const pendingTotalAmount = await billsPage.pendingBillsTable.getFirstRowCellValue('Total');
    const pendingStatus = await billsPage.pendingBillsTable.getFirstRowCellValue('Status');

    expect(pendingBillStartDate).toBe(state.nextMonthFirstDate);
    expect(pendingBillEndDate).toBe(state.nextTwoMonthsFirstDate);
    expect(pendingTotalAmount).toBe('0');
    expect(pendingStatus).toBe('PENDING');

  });

  test('TC-05: Recurring Billing Month 01', async ({
    page, testLogger, screenshotHelper, toast,
    serverHelper,
    dailySchedulePage,
    jobScheduleDbHelper,
    billsPage
  }) => {
    // Set CCP time to next two months first date
    const date = state.nextTwoMonthsFirstDate!;
    await serverHelper.setAndVerifyCcpTime(date);
    testLogger.data('Recurring Billing Month 01 Date', date);

    // Rerun job for the date next month first date
    await page.navigateToHome();
    await dailySchedulePage.navigateViaNav();
    await dailySchedulePage.inputJobCalendar(date);
    await screenshotHelper.captureAndAttach('TC-05-job-schedule-page');

    // If jobs list for that date already exists, clear it via DB helper
    await dailySchedulePage.clearExistingJobSchedule(jobScheduleDbHelper, date, testLogger);
    await screenshotHelper.captureAndAttach('TC-05-job-schedule-page-after-db-cleanup');

    // Verify cleanup
    try {
      const remainingJobs = await jobScheduleDbHelper.getJobSchedule(date);
      testLogger.data('Remaining jobs after cleanup', remainingJobs);
      expect(remainingJobs.length).toBe(0);
      testLogger.log('DB cleanup verified: no remaining job schedules.');
    } catch (error) {
      testLogger.error('DB cleanup verification failed', String(error));
    }

    // Process job schedule
    await dailySchedulePage.clickCreateJobSchedule();
    await toast.expectSuccess();
    testLogger.log('Job Schedule created successfully.');

    const jobListVisible = await dailySchedulePage.isJobListVisible();
    expect(jobListVisible).toBeTruthy();
    testLogger.log('Job cards are now visible on the UI.');

    await dailySchedulePage.clickProcess();
    await dailySchedulePage.confirmProcess();
    await toast.expectSuccess();
    testLogger.log('Process confirmed and started.');

    // Poll for all jobs to complete
    const allCompleted = await dailySchedulePage.waitForAllJobsCompleted(testLogger);
    expect(allCompleted).toBeTruthy();
    testLogger.log('All job cards have completed processing.');
    await screenshotHelper.captureAndAttach('TC-05-all-jobs-completed');

    // Navigate to the Bills list
    await page.goto(state.billsPageUrl!);
    await page.waitForLoadState('networkidle').catch(() => { });

    // Verify the new invoice in the Open/Closed Bills list

    const billType = await billsPage.table.getCellValue(1, 'Bill Type');
    const billStartDate = await billsPage.table.getCellValue(1, 'Start Date');
    const billEndDate = await billsPage.table.getCellValue(1, 'End Date');
    const totalAmount = await billsPage.table.getCellValue(1, 'Total');

    expect(billType).toBe('REGULAR');
    expect(billStartDate).toBe(state.nextMonthFirstDate);
    expect(billEndDate).toBe(state.nextTwoMonthsFirstDate);
    expect(totalAmount).toBe('19,273.67');

    // Verify the first record in the Pending Bills list
    const pendingBillStartDate = await billsPage.pendingBillsTable.getFirstRowCellValue('Start Date');
    const pendingBillEndDate = await billsPage.pendingBillsTable.getFirstRowCellValue('End Date');
    const pendingTotalAmount = await billsPage.pendingBillsTable.getFirstRowCellValue('Total');
    const pendingStatus = await billsPage.pendingBillsTable.getFirstRowCellValue('Status');

    expect(pendingBillStartDate).toBe(state.nextTwoMonthsFirstDate);
    expect(pendingBillEndDate).toBe(state.nextThreeMonthsFirstDate);
    expect(pendingTotalAmount).toBe('0');
    expect(pendingStatus).toBe('PENDING');
  });

  test('TC-06: Recurring Billing Month 02', async ({
    page, testLogger, screenshotHelper, toast,
    serverHelper,
    dailySchedulePage,
    jobScheduleDbHelper,
    billsPage
  }) => {
    // Set CCP time to next two months first date
    const date = state.nextThreeMonthsFirstDate!;
    await serverHelper.setAndVerifyCcpTime(date);
    testLogger.data('Recurring Billing Month 01 Date', date);

    // Rerun job for the date next month first date
    await page.navigateToHome();
    await dailySchedulePage.navigateViaNav();
    await dailySchedulePage.inputJobCalendar(date);
    await screenshotHelper.captureAndAttach('TC-06-job-schedule-page');

    // If jobs list for that date already exists, clear it via DB helper
    await dailySchedulePage.clearExistingJobSchedule(jobScheduleDbHelper, date, testLogger);
    await screenshotHelper.captureAndAttach('TC-06-job-schedule-page-after-db-cleanup');

    // Verify cleanup
    try {
      const remainingJobs = await jobScheduleDbHelper.getJobSchedule(date);
      testLogger.data('Remaining jobs after cleanup', remainingJobs);
      expect(remainingJobs.length).toBe(0);
      testLogger.log('DB cleanup verified: no remaining job schedules.');
    } catch (error) {
      testLogger.error('DB cleanup verification failed', String(error));
    }

    // Process job schedule
    await dailySchedulePage.clickCreateJobSchedule();
    await toast.expectSuccess();
    testLogger.log('Job Schedule created successfully.');

    const jobListVisible = await dailySchedulePage.isJobListVisible();
    expect(jobListVisible).toBeTruthy();
    testLogger.log('Job cards are now visible on the UI.');

    await dailySchedulePage.clickProcess();
    await dailySchedulePage.confirmProcess();
    await toast.expectSuccess();
    testLogger.log('Process confirmed and started.');

    // Poll for all jobs to complete
    const allCompleted = await dailySchedulePage.waitForAllJobsCompleted(testLogger);
    expect(allCompleted).toBeTruthy();
    testLogger.log('All job cards have completed processing.');
    await screenshotHelper.captureAndAttach('TC-06-all-jobs-completed');

    // Navigate to the Bills list
    await page.goto(state.billsPageUrl!);
    await page.waitForLoadState('networkidle').catch(() => { });

    // Verify the new invoice in the Open/Closed Bills list
    const billType = await billsPage.table.getCellValue(1, 'Bill Type');
    const billStartDate = await billsPage.table.getCellValue(1, 'Start Date');
    const billEndDate = await billsPage.table.getCellValue(1, 'End Date');
    const totalAmount = await billsPage.table.getCellValue(1, 'Total');

    expect(billType).toBe('REGULAR');
    expect(billStartDate).toBe(state.nextTwoMonthsFirstDate);
    expect(billEndDate).toBe(state.nextThreeMonthsFirstDate);
    expect(totalAmount).toBe('19,273.67');

    // Verify the first record in the Pending Bills list
    const pendingBillStartDate = await billsPage.pendingBillsTable.getFirstRowCellValue('Start Date');
    const pendingBillEndDate = await billsPage.pendingBillsTable.getFirstRowCellValue('End Date');
    const pendingTotalAmount = await billsPage.pendingBillsTable.getFirstRowCellValue('Total');
    const pendingStatus = await billsPage.pendingBillsTable.getFirstRowCellValue('Status');

    expect(pendingBillStartDate).toBe(state.nextThreeMonthsFirstDate);
    expect(pendingBillEndDate).toBe(state.nextFourMonthsFirstDate);
    expect(pendingTotalAmount).toBe('0');
    expect(pendingStatus).toBe('PENDING');
  });

});
