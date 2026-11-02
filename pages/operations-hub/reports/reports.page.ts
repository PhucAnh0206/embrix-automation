import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../base.page';
import { test, expect } from '../../../fixtures/page-factory';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { SidebarComponent } from '../../components/sidebar.component';
import { TableComponent } from '../../components/table.component';


/**
 * Reports — Page Object for the Reports screen.
 *
 * Accessed via: Operations Hub → Reports → Users
 */
export class ReportsPage extends BasePage {
    readonly table: TableComponent;
    readonly sidebar: SidebarComponent;


    constructor(page: Page) {
        super(page);
        this.table = new TableComponent(page, this.page.locator('table').first());
        this.sidebar = new SidebarComponent(page);

    }

    // ── DOM Selectors ────────────────────────────────────────────────────────
    private get startDateInput() { return this.page.locator(`//input[@name='startDate']`).first(); }
    private get endDateInput() { return this.page.locator(`//input[@name='endDate']`).first(); }
    private get searchButton() { return this.page.getByRole('button', { name: 'Search' }) }

    // ── Navigation ──────────────────────────────────────────────────────────

    /**
     * Navigate to Reports via top nav menu + sidebar.
     * Opens Operations Hub → Reports
     */
    async navigateViaNav(): Promise<void> {
        await this.hoverNavMenu(/Operations Hub/i);
        await this.clickNavLink(/Reports/i, /report/i);
        await this.page.waitForLoadingToDisappear();
    }

    async searchByDate(startDate: string, endDate: string): Promise<void> {
        await this.startDateInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.startDateInput.fill(startDate);
        await this.endDateInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.endDateInput.fill(endDate);


        const accountGroup = this.page.locator('div.form-group.select-group', { hasText: 'Account Type' });
        await accountGroup.locator('.custom-react-select__control').click();

        await this.page.locator('.custom-react-select__option')
            .filter({ hasText: 'DIRECT_CUSTOMER' })
            .first()
            .click();

    }
    async clickSearchButton(): Promise<void> {
        await this.page.waitForLoadState('networkidle')
        await this.searchButton.click();
        await this.page.waitForLoadingToDisappear();

    }

}