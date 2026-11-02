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
 * TaskManagement — Page Object for the Task Management screen.
 *
 * Accessed via: Operations Hub → Task Management → Tickets
 */
export class TaskManagementPage extends BasePage {
    readonly sidebar: SidebarComponent;
    readonly popup: Locator;
    readonly toastComponent: ToastComponent;

    constructor(page: Page) {
        super(page);
        this.sidebar = new SidebarComponent(page);
        this.toastComponent = new ToastComponent(page);
        this.popup = page.locator('[role="dialog"]').last(); // or your popup selector
    }

    // ── DOM Selectors ────────────────────────────────────────────────────────

    private get createTaskButton() { return this.page.getByRole('button', { name: 'Create Task', exact: true }); }
    private get searchButton() { return this.page.getByRole('button', { name: 'Search', exact: true }); }

    // ── Navigation ──────────────────────────────────────────────────────────

    /**
     * Navigate to Task screen via top nav menu + sidebar.
     * Opens Operations Hub → Task Management then tasks
     */
    async navigateViaNav(): Promise<void> {
        await this.hoverNavMenu(/Operations Hub/i);
        await this.clickNavLink(/Task Management/i, /task-management/i);
        await this.page.waitForLoadingToDisappear();
    }

    async clickCreateTaskButton(): Promise<void> {
        await this.createTaskButton.click();
        await this.page.waitForLoadingToDisappear();
        await this.page.waitForLoadState('networkidle').catch(() => { });
        await this.page.waitForTimeout(MEDIUM_WAIT);
    }
    async clickSearchButton(): Promise<void> {
        await this.searchButton.click();
        await this.page.waitForLoadingToDisappear();
        await this.page.waitForLoadState('networkidle').catch(() => { });
        await this.page.waitForTimeout(MEDIUM_WAIT);
    }


    async createTaskSuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
        const successToast = this.toastComponent.successToast;
        const errorToast = this.toastComponent.errorToast;

        // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
        const winner = await Promise.race([
            successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
            errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
        ]).catch(() => 'timeout' as const);

        if (winner === 'success') {

            await expect(successToast).toContainText('Create Task successfully!');
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
            console.log('===CREATE TASK FAILED ===');
            console.log('Error toast message:', errorMsg);
            throw new Error(`Create Task Failed: ${errorMsg}`);
        } else {
            // Capture whatever is on screen when timeout occurs
            if (screenshotHelper) {
                await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
            }
            throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
        }
    }


}