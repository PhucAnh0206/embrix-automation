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
 * UserManagement — Page Object for the User Management screen.
 *
 * Accessed via: Operations Hub → User Management → Users
 */
export class UserManagementPage extends BasePage {
    readonly table: TableComponent;
    readonly sidebar: SidebarComponent;
    readonly toastComponent: ToastComponent;
    readonly popup: Locator;
    readonly selectRoleModalTable: TableComponent;
    private username: string;

    constructor(page: Page) {
        super(page);
        this.table = new TableComponent(page, this.page.locator('table').first());
        this.sidebar = new SidebarComponent(page);
        this.popup = page.locator('[role="dialog"]').last(); // or your popup selector
        this.toastComponent = new ToastComponent(page);
        this.selectRoleModalTable = new TableComponent(page, this.selectRoleModal.locator('//div[@id="scrollableDiv"]').first());

    }

    // ── DOM Selectors ────────────────────────────────────────────────────────
    private get createNewUserButton() { return this.page.getByRole('link', { name: 'Create New User', exact: true }); }
    private get userIdInput() { return this.page.locator(`//input[@name='userId']`).first(); }
    private get passwordInput() { return this.page.locator(`//input[@name='password']`).first(); }
    private get addAddressButton() { return this.page.getByRole('button', { name: '+Add new address', exact: true }); }
    private get cityInput() { return this.page.locator(`//input[@name='city']`).first(); }
    private get streetInput() { return this.page.locator('textarea[name="street"]'); }
    private get stateInput() { return this.page.locator(`//input[@name='state']`).first(); }
    private get postalCodeInput() { return this.page.locator(`//input[@name='postalCode']`).first(); }

    private get addContactButton() { return this.page.getByRole('button', { name: '+Add new contact', exact: true }); }
    private get emailInput() { return this.page.locator(`//input[@name='email']`).first(); }
    private get firstNameInput() { return this.page.locator(`//input[@name='firstName']`).first(); }
    private get lastNameInput() { return this.page.locator(`//input[@name='lastName']`).first(); }

    private get createButton() { return this.page.getByRole('button', { name: 'Create', exact: true }); }
    private get searchButton() { return this.page.getByRole('button', { name: 'Search', exact: true }); }
    private get modifyButton() { return this.page.getByRole('button', { name: 'Modify', exact: true }); }
    private get addRoleButton() { return this.page.getByRole('button', { name: 'Add Role', exact: true }); }

    private get selectButton() { return this.popup.getByRole('button', { name: 'Select', exact: true }); }
    private get selectRoleModal() { return this.page.locator('//h5[@class="modal-title"][text()="Choose Roles"]/../..') }

    // ── Navigation ──────────────────────────────────────────────────────────

    /**
     * Navigate to Users screen via top nav menu + sidebar.
     * Opens Operations Hub → User Management then Users
     */
    async navigateViaNav(): Promise<void> {
        await this.hoverNavMenu(/Operations Hub/i);
        await this.clickNavLink(/User Management/i, /user-management/i);
        await this.page.waitForLoadingToDisappear();
    }


    async clickCreateUserButton(): Promise<void> {
        await this.createNewUserButton.click();
        await this.page.waitForLoadingToDisappear();
        await this.page.waitForLoadState('networkidle').catch(() => { });
        await this.page.waitForTimeout(MEDIUM_WAIT);
    }



    async addDetailsForUser(): Promise<void> {
        const randomSuffix = Math.floor(Math.random() * 1000000);
        //const username = `testUserTest${randomSuffix}`;
        this.username = `testUserTest${randomSuffix}`;
        await this.userIdInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.page.locator('input[name="userId"]').fill(this.username, { force: true });
        const userType = this.page.locator('div.form-group.select-group', { hasText: 'User Type' });
        await userType.locator('.custom-react-select__control').click();
        await this.page.locator('.custom-react-select__option')
            .filter({ hasText: 'AutoCuidado' })
            .first()
            .click();

        const userCategory = this.page.locator('div.form-group.select-group', { hasText: 'User Category' });
        await userCategory.locator('.custom-react-select__control').click();
        await this.page.locator('.custom-react-select__option')
            .filter({ hasText: 'CUSTOMER' })
            .first()
            .click();

        await this.passwordInput.fill('testUser123');
        await this.page.waitForTimeout(MEDIUM_WAIT);
        await this.page.locator('.accordion.gray.plus-icon.round')
            .locator('a.acd-heading', { hasText: 'User Address' })
            .click();
        await this.addAddressButton.click();
        await this.page.waitForLoadingToDisappear();
        await this.page.waitForLoadState('networkidle').catch(() => { });
        await this.page.waitForTimeout(MEDIUM_WAIT);

        const countryGroup = this.page.locator('div.form-group.select-group', { hasText: 'Country' });
        await countryGroup.locator('.custom-react-select__control').click();


        await this.page.locator('.custom-react-select__option')
            .filter({ hasText: 'Costa Rica' })
            .first()
            .click();

        await this.stateInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.stateInput.fill('Alajuela');
        await this.cityInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.cityInput.fill('Grecia');
        await this.postalCodeInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.postalCodeInput.fill('102333');
        await this.streetInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.streetInput.click();
        await this.streetInput.fill('celle');
        await this.page.waitForTimeout(MEDIUM_WAIT);
        await this.page.locator('.accordion.gray.plus-icon.round')
            .locator('a.acd-heading', { hasText: 'User Contact' })
            .click();

        await this.addContactButton.click();
        await this.page.waitForLoadingToDisappear();
        await this.page.waitForLoadState('networkidle').catch(() => { });
        await this.page.waitForTimeout(MEDIUM_WAIT);


        await this.firstNameInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.firstNameInput.fill('test');
        await this.lastNameInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.lastNameInput.fill('test');
        await this.emailInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.emailInput.fill('test@embrix.com');
        await this.page.waitForTimeout(MEDIUM_WAIT);

        await this.page.locator('.accordion.gray.plus-icon.round')
            .locator('a.acd-heading', { hasText: 'User Roles' })
            .click();
        await this.addRoleButton.click();
        await this.page.waitForLoadingToDisappear();
        await this.page.waitForLoadState('networkidle').catch(() => { });
        await this.page.waitForTimeout(MEDIUM_WAIT);

        await this.clickRadioButton();
        await this.selectButton.click();
        await this.page.waitForTimeout(SHORT_WAIT);
        await this.createButton.click();


    }

    async searchUser(): Promise<void> {
        await this.userIdInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.page.locator('input[name="userId"]').fill(this.username, { force: true });
        await this.searchButton.click();
        await this.page.waitForLoadingToDisappear();
        await this.page.waitForLoadState('networkidle').catch(() => { });
        await this.page.waitForTimeout(MEDIUM_WAIT);

        await this.page.locator('tbody tr').nth(0)
            .locator('a.btn.btn-outline-success', { hasText: 'View' })
            .click();
        await this.page.locator('.accordion.gray.plus-icon.round')
            .locator('a.acd-heading', { hasText: 'User Roles' })
            .click();
        await this.page.waitForTimeout(MEDIUM_WAIT);
        await this.modifyButton.click();
        await this.page.waitForLoadingToDisappear();
        await this.page.waitForLoadState('networkidle').catch(() => { });
        await this.page.waitForTimeout(MEDIUM_WAIT);

    }

    async createUserSuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
        const successToast = this.toastComponent.successToast;
        const errorToast = this.toastComponent.errorToast;

        // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
        const winner = await Promise.race([
            successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
            errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
        ]).catch(() => 'timeout' as const);

        if (winner === 'success') {

            await expect(successToast).toContainText('Create User successfully!');
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
            console.log('===CREATE USER FAILED ===');
            console.log('Error toast message:', errorMsg);
            throw new Error(`Create User Failed: ${errorMsg}`);
        } else {
            // Capture whatever is on screen when timeout occurs
            if (screenshotHelper) {
                await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
            }
            throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
        }
    }



    /**
     * Click on radio button of the first row
     */
    async clickRadioButton(): Promise<void> {
        const radioButton = await this.selectRoleModalTable.getCellByLocation(0, 'Selected')
        await radioButton.click();
    }


    async modifyUserSuccessfully(screenshotHelper?: ScreenshotHelper): Promise<string> {
        const successToast = this.toastComponent.successToast;
        const errorToast = this.toastComponent.errorToast;

        // Race between success toast and error toast (use VERY_LONG_WAIT for slow API responses)
        const winner = await Promise.race([
            successToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'success' as const),
            errorToast.waitFor({ state: 'visible', timeout: 2 * EXTRA_LONG_WAIT }).then(() => 'error' as const)
        ]).catch(() => 'timeout' as const);

        if (winner === 'success') {

            await expect(successToast).toContainText('Modify User successfully!');
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
            console.log('===MODIFY USER FAILED ===');
            console.log('Error toast message:', errorMsg);
            throw new Error(`Modify User Failed: ${errorMsg}`);
        } else {
            // Capture whatever is on screen when timeout occurs
            if (screenshotHelper) {
                await screenshotHelper.captureAndAttach('toast-timeout-screen-state');
            }
            throw new Error('Timeout: Neither success toast nor error toast appeared within the expected time.');
        }
    }


}