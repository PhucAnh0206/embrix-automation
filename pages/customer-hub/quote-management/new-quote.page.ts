import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../base.page';
import { TableComponent } from '../../components/table.component';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';

/**
 * New Quote — Page Object for the Quote creation screen.
 *
 * Accessed via: Clicking on create new button on Search quote page.
 */
export class NewQuote extends BasePage {
  readonly popup: Locator;
  readonly idInput: Locator;
  readonly bundleAllTable: TableComponent;

  constructor(page: Page) {
    super(page);

    this.popup = page.locator('[role="dialog"]'); // or your popup selector
    this.idInput = this.popup.locator('input[name="id"]'); // your input selector
    this.bundleAllTable = new TableComponent(
      page,
      this.popup.locator('//div[@id="scrollableDiv"]').first()
    );
  }
  private get createNewButton() { return this.page.getByRole('link', { name: 'Create new' }) }
  private get accountIdInput() { return this.page.locator(`//input[@name='accountId']`).first(); }
  private get searchButton() { return this.page.getByRole('button', { name: 'Search', exact: true }); }
  private get nextButton() { return this.page.getByRole('button', { name: 'Next' }).nth(1); }
  private get addBundleButton() { return this.page.getByRole('button', { name: 'Add Bundle', exact: true }); }
  private get selectButton() { return this.page.getByRole('button', { name: 'Select', exact: true }); }
  private get nextTopButton() { return this.page.getByRole('button', { name: 'Next', exact: true }); }
  private get getQuoteleButton() { return this.page.getByRole('button', { name: 'Get Quote', exact: true }); }
  private get getCancelButton() { return this.popup.getByRole('button', { name: 'Cancel', exact: true }); }
  private get getSaveButton() { return this.page.getByRole('button', { name: 'Save', exact: true }); }


  /** Fill the Account Id field and click SEARCH. */
  async searchByAccountId(accountId: string): Promise<void> {
    await this.accountIdInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.accountIdInput.fill(accountId);
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  /** Fill the  Id field and click SEARCH. */
  async searchById(id: string): Promise<void> {
    await this.idInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.idInput.fill(id);
    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  /**
  * Click on radio button of the first row
  */
  async clickRadioButtonById(): Promise<void> {
    const radioButton = await this.bundleAllTable.getCellByLocation(0, 'Selected')
    await radioButton.click();
  }

  async clickTopNextButton(): Promise<void> {
    await this.nextTopButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  async clickAddBundleButton(): Promise<void> {
    await this.addBundleButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  async clickSelectButton(): Promise<void> {
    await this.selectButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  async clickGetQuoteButton(): Promise<void> {
    await this.getQuoteleButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  async clickCancelQuoteButton(): Promise<void> {
    await this.getCancelButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  async clickSaveQuoteButton(): Promise<void> {
    await this.getSaveButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

}
