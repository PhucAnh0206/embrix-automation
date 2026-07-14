import { Page } from '@playwright/test';
import { BasePage } from '../../../../base.page';
import { LONG_WAIT, MEDIUM_WAIT } from '../../../../../helpers/timeouts.helper';
import { SidebarComponent } from '../../../../components/sidebar.component';
import { TableComponent } from '../../../../components/table.component';
import { TestLogger } from '../../../../../helpers/test-logger';

/**
 * CustomerActivityPage — Page Object for the Customer Activity screen.
 *
 */
export class CustomerActivityPage extends BasePage {
  readonly sidebar: SidebarComponent;
  readonly activityTable: TableComponent;

  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.sidebar = new SidebarComponent(page);
    this.activityTable = new TableComponent(this.page, this.page.locator('table').first());
  }

  /** DOM Elements */

  /** The dialog modal element containing Customer Activity details. */
  private get activityModal() { return this.page.locator('//div[@role="dialog"]') }

  /** The request JSON payload textarea inside the activity details modal. */
  private get activityRequest() { return this.activityModal.locator('//textarea[@name="request"]') }

  /** The confirmation OK button inside the activity details modal. */
  private get closeActivityModalButton() { return this.activityModal.locator("//button[text()='OK']") }

  private get clearButton() { return this.page.getByRole('button', { name: /CLEAR/i }).first(); }
  private get searchButton() { return this.page.getByRole('button', { name: /SEARCH/i }).first(); }

  /**
   * Navigate to Customer Activity via sidebar.
   */
  async navigateViaSideMenu(): Promise<void> {
    await this.sidebar.navigateTo('Account Data', 'Customer Activity');
  }

  /** Click the CLEAR button on the Customer Activity screen. */
  async clickClearButton(): Promise<void> {
    await this.clearButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.clearButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')
  }

  /** Click the SEARCH button on the Customer Activity screen. */
  async clickSearchButton(): Promise<void> {
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')
    await this.activityTable.rows.first().waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  /**
   * Find the row with a specific Api Name value and click its View button.
   * @param apiName The Api Name to search for (e.g. "UPDATE_WORK_ORDER")
   */
  async clickViewByApiName(apiName: string): Promise<void> {
    await this.activityTable.clickCellLinkByMatch('Api Name', apiName, 'View');

    // Assert modal title "Customer Activity"
    const modal = this.page.locator('[class*="modal"], [role="dialog"]').filter({ hasText: /Customer Activity/i }).first();
    await modal.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  /**
   * Find the LAST row with a specific Api Name value and click its View button.
   * @param apiName The Api Name to search for (e.g. "UPDATE_WORK_ORDER")
   */
  async clickViewByLastApiName(apiName: string): Promise<void> {
    const lastRowIndex = await this.activityTable.findLastRowIndex('Api Name', apiName);
    await this.activityTable.clickCellLink(lastRowIndex, 'View');

    await this.activityModal.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  /**
   * Get the content of the Request textarea inside the Customer Activity modal.
   */
  async getModalRequestContent(): Promise<string> {
    await this.activityRequest.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    return (await this.activityRequest.inputValue()).trim();
  }

  /**
   * Polls Customer Activity to verify that the request content for a specific API contains the expected status.
   * 
   * @param activityName - The activity name to view (e.g., 'UPDATE_WORK_ORDER')
   * @param expectedSubstrings - One or more substrings to check in the request content (e.g., '"status":"FINALIZADO"')
   * @param testLogger - Optional logger for reporting progress
   * @returns The request content string if successful, throws error if timed out
   */
  async waitForActivityRequestContent(
    activityName: string,
    expectedSubstrings: string | string[],
    testLogger?: TestLogger
  ): Promise<string> {
    const maxRetries = 10;
    let requestContent = '';
    const substrings = Array.isArray(expectedSubstrings) ? expectedSubstrings : [expectedSubstrings];

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.clickSearchButton();
        await this.page.waitForLoadingToDisappear();
        await this.clickViewByLastApiName(activityName);

        requestContent = await this.getModalRequestContent();

        // Close modal by clicking OK button to allow the next search click
        await this.closeActivityModalButton.click();
        await this.activityModal.waitFor({ state: 'hidden', timeout: MEDIUM_WAIT })

        const allMatched = substrings.every(sub => requestContent.includes(sub));
        if (allMatched) {
          testLogger?.log(`Provisioning completed and verified on retry #${i + 1}`);
          return requestContent;
        } else {
          testLogger?.log(`Details ${JSON.stringify(substrings)} not matched on retry #${i + 1}. Retrying...`);
          continue;
        }
      } catch (e: any) {
        testLogger?.log(`Retry #${i + 1} failed: ${e.message}`);
        // Ensure modal is closed on failure so next retry can proceed (only if it is actually open)
        if (await this.activityModal.isVisible()) {
          await this.closeActivityModalButton.click()
          await this.activityModal.waitFor({ state: 'hidden', timeout: MEDIUM_WAIT })
        }
      }

      // Wait before the next poll
      await new Promise(resolve => setTimeout(resolve, LONG_WAIT));
    }

    throw new Error(`Failed to verify activity request content containing ${JSON.stringify(substrings)} after ${maxRetries} retries (~${(maxRetries * LONG_WAIT) / 1000}s polling).`);
  }

}
