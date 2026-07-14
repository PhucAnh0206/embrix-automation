import { Page } from '@playwright/test';
import { BasePage } from '../../base.page';
import { JobScheduleDbHelper } from '../../../helpers/db/job-schedule.db';
import { MEDIUM_WAIT, LONG_WAIT, SHORT_WAIT } from '../../../helpers/timeouts.helper';
import { ServerHelper } from '../../../helpers/server-api.helper';
import { SidebarComponent } from '../../components/sidebar.component';
import { TestLogger } from '../../../helpers/test-logger';
import { ToastComponent } from '../../components/toast.component';

/**
 * DailySchedulePage — Page Object for the Daily Schedule screen.
 *
 * Accessed via: Operations Hub → Jobs Management → Daily Schedule
 */
export class DailySchedulePage extends BasePage {
    readonly sidebar: SidebarComponent;
    readonly serverHelper: ServerHelper;
    readonly jobScheduleDbHelper: JobScheduleDbHelper;
    readonly testLogger: TestLogger;
    readonly toastComponent: ToastComponent;

    constructor(
        page: Page,
        testLogger: TestLogger,
        serverHelper: ServerHelper,
        jobScheduleDbHelper: JobScheduleDbHelper
    ) {
        super(page);
        this.sidebar = new SidebarComponent(page);
        this.serverHelper = serverHelper;
        this.jobScheduleDbHelper = jobScheduleDbHelper;
        this.testLogger = testLogger;
        this.toastComponent = new ToastComponent(page);
    }

    /** DOM Elements */
    private get jobCalendarInput() { return this.page.locator('.react-datepicker__input-container input'); }
    private get createJobScheduleButton() { return this.page.getByRole('button', { name: 'Create Job Schedule', exact: true }); }
    private get processButton() { return this.page.getByRole('button', { name: 'Process', exact: true }); }
    private get refreshJobsButton() { return this.page.locator('button[title="Refresh jobs"]'); }
    private get confirmYesButton() { return this.page.getByRole('button', { name: 'Yes', exact: true }); }

    /** All job card elements on the page (each card has an h6 title, status label, etc.) */
    private get jobCards() { return this.page.locator('.card').filter({ has: this.page.locator('h6') }); }

    /**
     * Navigate to Daily Schedule screen via top nav menu + sidebar.
     * Opens Operations Hub → Jobs Management, then selects DAILY from the sidebar.
     */
    async navigateViaNav(): Promise<string> {
        await this.page.navigateToHome()
        await this.hoverNavMenu(/Operations Hub/i);
        await this.clickNavLink(/Jobs Management/i, /job-schedule/i);
        await this.page.waitForLoadingToDisappear();
        return await this.sidebar.navigateTo('Jobs Management', 'DAILY');
    }

    /**
     * Input job calendar date (format: YYYY-MM-DD)
     * @param date - Date to input in YYYY-MM-DD format
     */
    async inputJobCalendar(date: string): Promise<void> {
        await this.jobCalendarInput.click();
        await this.page.keyboard.press('Control+A');
        await this.page.keyboard.press('Backspace');
        await this.jobCalendarInput.fill(date);
        await this.jobCalendarInput.press('Enter');
        await this.page.waitForLoadingToDisappear();
    }

    /**
     * Click on Create Job Schedule button and wait for success toast
     */
    async clickCreateJobSchedule(): Promise<void> {
        await this.createJobScheduleButton.click();
        await this.page.waitForLoadingToDisappear();
    }

    /**
     * Click the Process button to process all pending jobs
     */
    async clickProcess(): Promise<void> {
        await this.processButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
        await this.processButton.click();
    }

    /**
     * Click Yes on the confirmation modal that appears after clicking Process
     */
    async confirmProcess(): Promise<void> {
        await this.confirmYesButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
        await this.confirmYesButton.click();
        await this.toastComponent.successToast.waitFor({ state: 'visible', timeout: SHORT_WAIT });
        await this.page.waitForLoadingToDisappear();
    }

    /**
     * Click the Refresh jobs button
     */
    async clickRefreshJobs(): Promise<void> {
        await this.refreshJobsButton.click();
        await this.page.waitForLoadingToDisappear();
    }

    /**
     * Check if any job card still has "Pending" status.
     * Returns true if at least one job card has Pending status.
     */
    async hasAnyPendingJob(): Promise<boolean> {
        const cardCount = await this.jobCards.count();
        for (let i = 0; i < cardCount; i++) {
            const card = this.jobCards.nth(i);
            const statusText = await card.locator('text=Pending').count();
            if (statusText > 0) return true;
        }
        return false;
    }

    /**
     * Check if the job cards list is visible on the page (i.e., jobs exist for the selected date)
     */
    async isJobListVisible(): Promise<boolean> {
        return (await this.jobCards.count()) > 0;
    }

    /**
     * Wait for all job cards to finish processing (no more Pending status).
     * Polls by clicking Refresh and checking statuses, up to maxRetries times.
     * @returns true if all jobs completed within the retry limit, false otherwise
     */
    async waitForAllJobsCompleted(
        maxRetries: number = 10,
        date?: string
    ): Promise<boolean> {
        // Wait for job cards to be visible before checking statuses
        await this.jobCards.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const hasPending = await this.hasAnyPendingJob();

            if (!hasPending) {
                this.testLogger.log(`All jobs completed after ${attempt} check(s).`);
                return true;
            }

            this.testLogger.log(`Attempt ${attempt}/${maxRetries}: Some jobs still Pending. Refreshing...`);
            // Unblock the billing engine in case other accounts on the sandbox database failed and blocked progress
            await this.jobScheduleDbHelper.cleanStuckJobs(date).catch(e => this.testLogger.error("Failed to clean stuck jobs in loop", String(e)));
            await this.page.waitForTimeout(LONG_WAIT);
            await this.clickRefreshJobs();
        }

        this.testLogger.error(`Jobs did not complete within ${maxRetries} retries.`, '');
        return false;
    }

    /**
     * Clear jobs for the first date, sixteenth date, seventeenth date, and twenty first date of a month
     * @param dateObject - Object containing the dates to clear
     */
    async clearJobsForEachMonth(
        dateObject: {
            firstDate: string;
            sixteenthDate?: string;
            seventeenthDate?: string;
            twentyFirstDate?: string;
        }
    ) {
        const datesToClear = [
            dateObject.firstDate,
            dateObject.sixteenthDate,
            dateObject.seventeenthDate,
            dateObject.twentyFirstDate
        ].filter((date): date is string => !!date);

        for (const date of datesToClear) {
            try {
                this.testLogger.log(`START: Clearing job schedule for date ${date}`);
                const jobSchedules = await this.jobScheduleDbHelper.getJobSchedule(date);
                this.testLogger.data(`Job Schedules to delete for date ${date}: `, jobSchedules);

                for (const job of jobSchedules) {
                    await this.jobScheduleDbHelper.deleteJobScheduleById(job.id);
                    this.testLogger.log(`Deleted job schedule ID: ${job.id}`);
                }
                this.testLogger.log(`END: Clearing job schedule for date ${date}`);
            } catch (error) {
                this.testLogger.error(`Failed to clean up job schedules via DB for date ${date}`, String(error));
                throw error;
            }
        }
    }

    /**
     * Create and run jobs for a specific date
     * @param date - Date for which to create and run jobs (format: YYYY-MM-DD)
     */
    async createAndRunJobsForDate(
        date: string
    ) {
        // Unblock the billing engine scheduler before starting the run
        await this.jobScheduleDbHelper.cleanStuckJobs(date).catch(e => this.testLogger.error("Failed to clean stuck jobs initially", String(e)));

        await this.navigateViaNav();
        await this.inputJobCalendar(date);

        const isCreateJobScheduleButtonVisible = await this.createJobScheduleButton.isVisible();

        if (isCreateJobScheduleButtonVisible) {
            await this.clickCreateJobSchedule();
            await this.clickRefreshJobs();
        }

        await this.clickProcess()
        await this.confirmProcess()
        await this.clickRefreshJobs();
        await this.waitForAllJobsCompleted(10, date)
    }

    /**
     * Repare jobs for each month
     * @param dateObject - Object containing the dates to clear
     * @param serverHelper - Server helper for API operations
     * @param testLogger - Test logger for logging purposes
     */
    async repareJobsForEachMonth(
        dateObject: {
            firstDate: string;
            sixteenthDate?: string;
            seventeenthDate?: string;
            twentyFirstDate?: string;
        }
    ) {
        this.testLogger.data('START - Repare daily jobs for date:', dateObject);
        await this.clearJobsForEachMonth(dateObject)
        await this.serverHelper.setAndVerifyCcpTime(dateObject.firstDate)
        await this.createAndRunJobsForDate(dateObject.firstDate)
        this.testLogger.data('END - Repare daily jobs for date:', dateObject);
    }
}