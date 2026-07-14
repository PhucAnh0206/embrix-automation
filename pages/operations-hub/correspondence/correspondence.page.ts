import { Page, Locator } from '@playwright/test';
import { BasePage } from '../../base.page';
import { test, expect } from '../../../fixtures/page-factory';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { SidebarComponent } from '../../components/sidebar.component';
import { TestLogger } from '../../../helpers/test-logger';
import { ToastComponent } from '../../components/toast.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';
import { TableComponent } from '../../components/table.component';


/**
 * Templetes — Page Object for the Correspondence screen.
 *
 * Accessed via: Operations Hub → Correspondence → Templates
 */
export class CorrspondencePage extends BasePage {
    readonly sidebar: SidebarComponent;
    readonly popup: Locator;

    constructor(page: Page) {
        super(page);
        this.sidebar = new SidebarComponent(page);
        this.popup = page.locator('[role="dialog"]').last(); // or your popup selector
    }

    // ── DOM Selectors ────────────────────────────────────────────────────────


    // ── Navigation ──────────────────────────────────────────────────────────

    /**
     * Navigate to Users screen via top nav menu + sidebar.
     * Opens Operations Hub → User Management then Users
     */
    async navigateViaNav(): Promise<void> {
        await this.hoverNavMenu(/Operations Hub/i);
        await this.clickNavLink(/Correspondence/i, /config-template/i);
        await this.page.waitForLoadingToDisappear();
    }



}