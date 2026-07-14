import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../base.page';
import { TableComponent } from '../../components/table.component';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, VERY_LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';

/**
 * Search Quote — Page.
 *
 * Accessed via: Clicking on Quote management under Customer hub.
 */
export class SearchQuote extends BasePage {

  constructor(page: Page) {
    super(page);

  }
  private get createNewButton() { return this.page.getByRole('link', { name: 'Create new' }) }



  /** Hover on "Customer Hub" → click "Quote Management" link. */
  async navigateQuoteViaNav(): Promise<void> {
    await this.hoverNavMenu(/Customer Hub/i);
    await this.clickNavLink(/Quote Management/i, /quote/i);
  }

  /** Click the CLEAR button on the Search Quote screen. */
  async clickClearButton(): Promise<void> {
    const clearBtn = this.page.getByRole('button', { name: /CLEAR/i }).first();
    await clearBtn.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await clearBtn.click();
    await this.page.waitForTimeout(500);
  }

  /** Click the SEARCH button on the Search Quote screen. */
  async clickSearchButton(): Promise<void> {
    const searchBtn = this.page.getByRole('button', { name: /SEARCH/i }).first();
    await searchBtn.click();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(1000);
  }

  /** Click the CREATE NEW button on the Search Quote screen. */
  async clickCreateNewButton(): Promise<void> {
    await this.createNewButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.createNewButton.click();
    await this.page.waitForLoadState('networkidle').catch(() => { });
    await this.page.waitForTimeout(SHORT_WAIT);
  }






}
