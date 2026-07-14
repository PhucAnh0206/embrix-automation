import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from '../../base.page';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import * as fs from 'fs';
import * as path from 'path';
import { TableComponent } from '../../components/table.component';
import { ToastComponent } from '../../components/toast.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';

/**
 * OrderManagementPage — Page Object for the Order Management screen.
 *
 * Accessed via: Customer Hub → Order Management
 */
export class OrderManagementPage extends BasePage {
  readonly table: TableComponent;
  readonly selectOrderModalTable: TableComponent;
  readonly serviceTable: TableComponent;
  readonly toastComponent: ToastComponent;

  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.table = new TableComponent(page, this.page.locator('table').first());
    this.selectOrderModalTable = new TableComponent(page, this.selectOrderModal.locator('//div[@id="scrollableDiv"]').first());
    this.serviceTable = new TableComponent(page, this.page.locator('//div[not(@id="scrollableDiv")]/table'));
    this.toastComponent = new ToastComponent(page);
  }

  // DOM Elements
  private get createNewOrderButton() { return this.page.getByRole('link', { name: 'Create new order' }) }
  private get accountIdInput() { return this.page.locator('input[name="accountId"]') }
  private get searchButton() { return this.page.getByRole('button', { name: 'Search' }) }
  private get referenceOrderInput() { return this.page.locator("//input[@name='referenceOrder']") }
  private get selectOrderModal() { return this.page.locator('//h5[@class="modal-title"][text()="Select Order"]/../..') }
  private get selectOrderModalOrderIDInput() { return this.selectOrderModal.locator("//input[@name='orderId']") }
  private get selectOrderModalSelectButton() { return this.selectOrderModal.getByRole('button', { name: 'Select' }) }
  private get firstSubPanel() { return this.page.locator('//span[@class="panel__title"][text()="Subscription: FIRST_INVOICE_SUBSCRIPTION"]') }
  private get viewProvisioningModal() { return this.page.locator('//h5[@class="modal-title"][text()="View Provisioning Data"]/../..') }
  private get viewProvisioningModalAddBtn() { return this.viewProvisioningModal.getByRole('button', { name: '+Add' }) }
  private get viewProvisioningModalProvisioningIDInput() { return this.viewProvisioningModal.locator("//input[@name='provisioningId']").last() }
  private get viewProvisioningModalOntModelInput() { return this.viewProvisioningModal.locator("//input[@name='flexAttr1']").last() }
  private get viewProvisioningModalSubmitButton() { return this.viewProvisioningModal.getByRole('button', { name: 'Submit' }) }
  private get createProvisioningOrderButton() { return this.page.getByRole('button', { name: 'Create' }) }
  private get orderIdInput() { return this.page.locator('input[name="orderId"]') }
  private get submitOrderButton() { return this.page.getByRole('button', { name: 'Submit order' }) }


  /** Hover on "Customer Hub" → click "Order Management" link. */
  async navigateViaNav(): Promise<void> {
    await this.hoverNavMenu(/Customer Hub/i);
    await this.clickNavLink(/Order Management/i, /order/i);
  }

  /** Click the "CREATE NEW ORDER" button. */
  async clickCreateNewOrder(): Promise<void> {
    await this.createNewOrderButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.createNewOrderButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')
    await this.accountIdInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  /** Fill the Account Id field and click SEARCH. */
  async searchAccountById(accountId: string): Promise<void> {
    await this.accountIdInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.accountIdInput.fill(accountId);

    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')

    // Wait for the row with accountId to appear in the table
    const row = this.table.rows.filter({ hasText: accountId }).first();
    await row.waitFor({ state: 'visible', timeout: MEDIUM_WAIT }).catch(() => { });
  }

  /**
   * Get the text content of a cell in the first row by column name.
   */
  async getFirstRowCellValue(columnName: string): Promise<string> {
    return this.table.getFirstRowCellValue(columnName);
  }

  /**
   * Click the "Next" button in the Selected column of the first row.
   */
  async clickNextInFirstRow(): Promise<void> {
    const nextButton = await this.table.getCellByLocation(0, 'Selected');
    await nextButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')
    await this.referenceOrderInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }
  /**
     * Click on the Reference Order field to open the Select Order modal
     */
  async clickReferenceOrder(): Promise<void> {
    await this.referenceOrderInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.referenceOrderInput.click();
    await this.selectOrderModal.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  /**
     * Search for the order
     * @param orderId 
     */
  async searchByOrderId(orderId: string): Promise<void> {
    await this.selectOrderModalOrderIDInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.selectOrderModalOrderIDInput.fill(orderId);
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();

    // Wait for the row with orderId to appear in the select order modal table
    const row = this.selectOrderModalTable.rows.filter({ hasText: orderId }).first();
    await row.waitFor({ state: 'visible', timeout: MEDIUM_WAIT }).catch(() => { });

    const orderIdInTable = await this.selectOrderModalTable.getFirstRowCellValue('Id');
    expect(orderIdInTable).toBe(orderId);
  }

  /**
   * Click on radio button of the first row
   */
  async clickRadioButtonByOrderId(): Promise<void> {
    const radioButton = await this.selectOrderModalTable.getCellByLocation(0, 'Selected')
    await radioButton.click();
  }

  /**
   * Click on Select button
   */
  async clickSelectButton(): Promise<void> {
    await this.selectOrderModalSelectButton.click();
    await this.page.waitForLoadState('networkidle')
    await this.selectOrderModal.waitFor({ state: 'hidden', timeout: MEDIUM_WAIT });
  }

  /**
   * Click on the Reference Order field → select first row in the "Select Order" modal → click Select button.
   */
  async selectReferenceOrder(orderId: string): Promise<void> {
    await this.clickReferenceOrder();
    await this.searchByOrderId(orderId);
    await this.clickRadioButtonByOrderId();
    await this.clickSelectButton();
  }

  /**
   * Click the "View" button in the View column of the first row.
   * Opens the "View Provisioning Data" modal.
   */
  async openProvisioningModal(): Promise<void> {
    // Verify the subscription text is visible
    await this.firstSubPanel.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.serviceTable.clickCellLink(0, 'View');
    await this.page.waitForLoadingToDisappear()
    await this.viewProvisioningModal.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  /**
   * Click on the Add button
   */
  async clickAddButton(): Promise<void> {
    await this.viewProvisioningModalAddBtn.click();
    // Verify new Provisioning ID & Ont Model new row
    await expect(this.viewProvisioningModalProvisioningIDInput).toHaveValue('');
    await expect(this.viewProvisioningModalOntModelInput).toHaveValue('');
  }

  /**
   * Input Provisioning ID
   * @param provisioningId 
   */
  async inputProvisioningId(provisioningId: string): Promise<void> {
    await this.viewProvisioningModalProvisioningIDInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.viewProvisioningModalProvisioningIDInput.fill(provisioningId);
  }

  /**
   * Input Ont Model
   * @param ontModel 
   */
  async inputOntModel(ontModel: string): Promise<void> {
    await this.viewProvisioningModalOntModelInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.viewProvisioningModalOntModelInput.fill(ontModel);
  }

  /**
   * Click Submit button
   */
  async clickSubmitButton(): Promise<void> {
    await this.viewProvisioningModalSubmitButton.click();
    await this.page.waitForLoadingToDisappear();
    await expect(this.viewProvisioningModal).not.toBeVisible({ timeout: MEDIUM_WAIT });
  }

  /**
   * Inside the "View Provisioning Data" modal:
   * Click "+ADD" → fill provisioningId and ontModel → click SUBMIT.
   * Reads provisioning data from test-data/provisioning.data.json if not provided.
   */
  async addProvisioningData(provisioningId?: string, ontModel?: string): Promise<void> {
    if (!provisioningId || !ontModel) {
      const filePath = path.join(process.cwd(), 'test-data', 'provisioning.data.json');
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as Array<{ provisioningId: string; ontModel: string }>;
      provisioningId = provisioningId ?? data[0].provisioningId;
      ontModel = ontModel ?? data[0].ontModel;
    }
    await this.openProvisioningModal()
    await this.clickAddButton()
    await this.inputProvisioningId(provisioningId)
    await this.inputOntModel(ontModel)
    await this.clickSubmitButton()
  }

  /**
   * Click the NEXT button above the "Subscription: FIRST_INVOICE_SUBCRIPTION" text.
   */
  async clickNextAboveSubscription(): Promise<void> {
    // Look for the NEXT button that is above/before the subscription text
    const nextBtn = this.page.getByRole('button', { name: /NEXT/i }).first();
    await nextBtn.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await nextBtn.click();
    await this.page.waitForLoadState('networkidle')
    await this.createProvisioningOrderButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  /**
   * On the final screen, click CREATE and wait for the page to process.
   */
  async clickCreate(): Promise<void> {
    await this.createProvisioningOrderButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.createProvisioningOrderButton.click();
    await this.page.waitForLoadingToDisappear();
  }

  /**
   * Verify the successful toast is displayed and wait for the redirected order detail screen.
   * If creation fails, extracts the error message from the error toast, logs it, and throws an error.
   *
   * @param screenshotHelper - Optional. When provided, captures screenshots at the exact moment
   *                           of error/timeout and attaches them to the Playwright HTML report.
   *                           This ensures you see the toast/error on screen, not a blank page.
   * @returns the URL of the new order detail page if successful.
   */
  async isProvisioningOrderSuccessfulToastAppear(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);

    if (winner === 'success') {
      await expect(successToast).toContainText('Create Order successfully');
      // Wait for the redirected Order Detail page URL
      await this.page.waitForURL(/\/orders\/ORD-\d+\/detail/, { timeout: LONG_WAIT });
      await this.page.waitForLoadState('networkidle')
      return this.page.url();
    } else if (winner === 'error') {
      // Capture the screen WHILE the error toast is still visible
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('error-toast-visible');
        await screenshotHelper.captureElementAndAttach(
          'error-toast-detail',
          '.Toastify__toast--error',
        );
      }
      const errorMsg = await this.toastComponent.getErrorMessage();
      console.log('=== PROVISIONING ORDER CREATION FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Provisioning Order Creation Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }

  /**
   * Search for the order
   * @param orderId 
   */
  async searchOrderId(orderId: string): Promise<void> {
    await this.orderIdInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.orderIdInput.fill(orderId);
    await this.searchButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.searchButton.click();
  }

  async clickSubmitOrderButton(): Promise<void> {
    await this.submitOrderButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
  }


  async isUpdateOrderSuccesfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
    const successToast = this.toastComponent.successToast;
    const errorToast = this.toastComponent.errorToast;

    // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
    const winner = await Promise.race([
      successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
      errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
    ]).catch(() => 'timeout' as const);

    if (winner === 'success') {
      await expect(successToast).toContainText('Update Order Status successfully!');
      await this.page.waitForLoadState('networkidle')
      return this.page.url();
    } else if (winner === 'error') {
      // Capture the screen WHILE the error toast is still visible
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('error-toast-visible');
        await screenshotHelper.captureElementAndAttach(
          'error-toast-detail',
          '.Toastify__toast--error',
        );
      }
      const errorMsg = await this.toastComponent.getErrorMessage();
      console.log('=== Order update  FAILED ===');
      console.log('Error toast message:', errorMsg);
      throw new Error(`Order update Failed: ${errorMsg}`);
    } else {
      // Capture whatever is on screen when timeout occurs
      if (screenshotHelper) {
        await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
      }
      throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
    }
  }

}
