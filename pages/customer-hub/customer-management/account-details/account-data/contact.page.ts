import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from '../../../../base.page';
import { SHORT_WAIT, LONG_WAIT, MEDIUM_WAIT, VERY_LONG_WAIT } from '../../../../../helpers/timeouts.helper';
import { AccountDetailsSidebar } from '../account-details-sidebar';
import { TableComponent } from '../../../../components/table.component';

/**
 * ContactPage — Page Object for the Account Info / Contact screen.
 *
 * Accessed via: Clicking an account number in Customer Management search results.
 */
export class ContactPage extends BasePage {
  readonly sidebar: AccountDetailsSidebar;
  readonly activityTable: TableComponent;
  readonly popup: Locator;
  readonly firstNameInput: Locator;
  readonly lastNameInput: Locator;
  /**
   * @param page - Playwright's Page instance.
   */
  constructor(page: Page) {
    super(page);
    this.sidebar = new AccountDetailsSidebar(page);
    this.popup = page.locator('[role="dialog"]'); // or your popup selector
    this.activityTable = new TableComponent(this.page, this.page.locator('table').first());
    this.firstNameInput = this.popup.locator('input[name="firstName"]'); // your input selector
    this.lastNameInput = this.popup.locator('input[name="lastName"]'); // your input selector
  }

  // DOM Elements
  private get addNewContact() { return this.page.getByRole('button', { name: 'Add new contact', exact: true }); }
  private get addButton() { return this.popup.getByRole('button', { name: 'Add new contact', exact: true }); }
  private get modifyButton() { return this.page.getByRole('button', { name: 'Modify', exact: true }); }


  /**
   * Navigate to Customer Activity via sidebar.
   */
  async navigateToContactActivity(): Promise<void> {
    await this.sidebar.navigateToSubScreen('Account Data', 'Contact');
  }



  async clickAddNewContact(): Promise<void> {
    await this.addNewContact.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')

  }

  async addContactDetails(): Promise<void> {
    await this.firstNameInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.firstNameInput.click();
    await this.firstNameInput.fill('Danial');

    await this.lastNameInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.lastNameInput.fill('Danial');


    await this.addButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle')
    await this.modifyButton.click();
  }



}
