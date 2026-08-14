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
export class CreateOrderPage extends BasePage {
  readonly table: TableComponent;
  readonly toastComponent: ToastComponent;
  readonly idInput: Locator;
  readonly popup: Locator;
  readonly bundleAllTable: TableComponent;


  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.table = new TableComponent(page, this.page.locator('table').first());
    this.toastComponent = new ToastComponent(page);
    this.popup = page.locator('[role="dialog"]'); // or your popup selector
    this.idInput = this.popup.locator('input[name="id"]'); // your input selector

    this.bundleAllTable = new TableComponent(
      page,
      this.popup.locator('//div[@id="scrollableDiv"]').first()
    );
  }

  // DOM Elements

  private get nextTopButton() { return this.page.getByRole('button', { name: 'Next', exact: true }).first(); }
  private get addAlaCarteButton() { return this.page.getByRole('button', { name: 'Add Ala Carte', exact: true }); }
  private get nextBottomButton() { return this.page.getByRole('button', { name: 'Next', exact: true }).last(); }
  private get searchButton() { return this.page.getByRole('button', { name: 'Search', exact: true }); }
  private get selectButton() { return this.page.getByRole('button', { name: 'Select', exact: true }); }
  private get createButton() { return this.page.getByRole('button', { name: 'Create', exact: true }); }


  async clickTopNextButton(): Promise<void> {
    await this.nextTopButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.nextTopButton.click();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    // await this.page.waitForTimeout(SHORT_WAIT);
    await this.page.waitForLoadingToDisappear();
  }

  async clickBottomNextButton(): Promise<void> {
    await this.nextBottomButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.nextBottomButton.click();
    await this.page.waitForLoadState('networkidle').catch(() => { });

  }

  async clickAddAlaCarteButton(): Promise<void> {
    await this.addAlaCarteButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.addAlaCarteButton.click();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  /** Fill the  Name field and click SEARCH. */
  async searchByName(name: string): Promise<void> {
    await this.idInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.idInput.fill(name);

    await this.searchButton.click();
    await this.page.waitForLoadingToDisappear();

  }

  /**
  * Click on radio button of the first row
  */
  async clickRadioButtonById(): Promise<void> {

    const targetRow = this.popup.locator('table tr').filter({
      hasText: 'PO_FR'

    });
    await targetRow.click();
  }


  async clickSelectButton(): Promise<void> {
    await this.selectButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(MEDIUM_WAIT);
  }

  async clickCreateButton(): Promise<void> {
    await this.createButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.createButton.click();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForLoadingToDisappear();
  }


}
