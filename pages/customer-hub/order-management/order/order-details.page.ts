import { Page, expect } from '@playwright/test';
import { BasePage } from '../../../base.page';
import { MEDIUM_WAIT } from '../../../../helpers/timeouts.helper';
import { TableComponent } from '../../../components/table.component';
import { ToastComponent } from '../../../components/toast.component';
import { TestLogger } from '../../../../helpers/test-logger';

import * as fs from 'fs';
import * as path from 'path';


/**
 * OrderDetailsPage — Page Object for the Order Details screen.
 *
 * Accessed via: Subscription Data sidebar → Assets → Services
 */
export class OrderDetailsPage extends BasePage {
    readonly toastComponent: ToastComponent;
    readonly testLogger: TestLogger;

    constructor(page: Page, testLogger: TestLogger) {
        super(page);
        this.toastComponent = new ToastComponent(page);
        this.testLogger = testLogger;
    }

    /** DOM Elements */
    private get subscriptionFormButton() { return this.page.getByRole('button', { name: 'Subscription:' }) }

    private get subscriptionForm() {
        return this.page.locator('.collapse__wrapper.sub_collapse').filter({ hasText: /Subscription:/ });
    }

    private getServiceTable(serviceType: string) {
        return new TableComponent(
            this.page,
            this.subscriptionForm.locator(`//h5[contains(text(), "Service Type: ${serviceType}")]/following::table[1]`)
        );
    }

    private get updateOrderButton() { return this.page.getByRole('button', { name: 'UPDATE ORDER' }) }
    private get submitOrderButton() { return this.page.getByRole('button', { name: 'SUBMIT ORDER' }) }

    /**
     * Click on the Subscription button to open the subscription form
     */
    async openSubscriptionForm(): Promise<void> {
        await this.subscriptionFormButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
        await this.subscriptionFormButton.click();
        await this.page.waitForLoadingToDisappear();

        await expect(this.subscriptionForm).toHaveClass(/opened/, { timeout: MEDIUM_WAIT });
    }

    /**
     * Verify the added services in the Subscription form
     * @param serviceType
     * @param bundleName
     */
    async isServiceAppearInSubscription(serviceType: string, bundleName: string): Promise<void> {
        const table = this.getServiceTable(serviceType);
        await expect(table.tableLocator).toBeVisible({ timeout: MEDIUM_WAIT });
        const rowIndex = await table.findRowIndex('Bundle Name', bundleName);
        expect(rowIndex).toBeGreaterThanOrEqual(0);
    }

    /**
     * Input Provisioning data
     * @param serviceType
     * @param bundleName 
     * @param provisingId
     * @param ontModel
    */
    async inputProvisioningData(serviceType: string, bundleName: string, provisingId: string, ontModel: string): Promise<void> {

        this.testLogger?.data('Provisioning data', { serviceType, bundleName, provisingId, ontModel });

        const table = this.getServiceTable(serviceType);
        const rowIndex = await table.findRowIndex('Bundle Name', bundleName);

        const headers = await table.getHeaders();

        if (headers.has('Provisioning Id')) {
            const provisioningCell = await table.getCellByLocation(rowIndex, 'Provisioning Id');
            await provisioningCell.locator('input').fill(provisingId);
        }

        if (headers.has('Serial Number')) {
            const serialNumberCell = await table.getCellByLocation(rowIndex, 'Serial Number');
            await serialNumberCell.locator('input').fill(ontModel);
        }

        if (headers.has('Model')) {
            const modelCell = await table.getCellByLocation(rowIndex, 'Model');
            await modelCell.locator('input').fill(ontModel);
        }
    }

    /**
     * Click Update Order button
     */
    async clickUpdateOrderButton(): Promise<void> {
        await this.updateOrderButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
        await this.updateOrderButton.click();
        try {
            await this.toastComponent.expectSuccess();
        } catch (error) {
            const errorMsg = await this.toastComponent.getErrorMessage().catch(() => '');
            if (errorMsg) {
                console.log(`Update Order Failed: ${errorMsg}`);
            }
            throw error;
        }
    }

    /**
     * Click Submit Order button
     */
    async clickSubmitOrderButton(): Promise<void> {
        await this.submitOrderButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
        await this.submitOrderButton.click();
        try {
            await this.toastComponent.expectSuccess();
        } catch (error) {
            const errorMsg = await this.toastComponent.getErrorMessage().catch(() => '');
            if (errorMsg) {
                console.log(`Submit Order Failed: ${errorMsg}`);
            }
            throw error;
        }
    }

    /**
     * Update Provisioning data
    */
    async updateProvisioningOrder(): Promise<void> {
        const serviceFilePath = path.join(process.cwd(), 'test-data', 'services.data.json');
        const services = JSON.parse(fs.readFileSync(serviceFilePath, 'utf-8'));
        const provisioningFilePath = path.join(process.cwd(), 'test-data', 'provisioning.data.json');
        const provisioningData = JSON.parse(fs.readFileSync(provisioningFilePath, 'utf-8'));

        const serviceType = services[0].services.serviceType;
        const bundleName = services[0].bundleName;
        const provisingId = provisioningData[0].provisioningId;
        const ontModel = provisioningData[0].ontModel;

        await this.openSubscriptionForm()
        await this.isServiceAppearInSubscription(serviceType, bundleName)
        await this.inputProvisioningData(serviceType, bundleName, provisingId, ontModel)
        await this.clickUpdateOrderButton()
        await this.clickSubmitOrderButton()
    }

}
