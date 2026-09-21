import { Page } from '@playwright/test';
import { BasePage } from '../../base.page';
import { MEDIUM_WAIT, LONG_WAIT } from '../../../helpers/timeouts.helper';
import { SidebarComponent } from '../../components/sidebar.component';
import { JobScheduleDbHelper } from '../../../helpers/db/job-schedule.db';
import { TestLogger } from '../../../helpers/test-logger';

/**
 * DailySchedulePage — Page Object for the Daily Schedule screen.
 *
 * Accessed via: Operations Hub → Jobs Management → Daily Schedule
 */
export class DailySchedulePage extends BasePage {
    readonly sidebar: SidebarComponent;

    constructor(page: Page) {
        super(page);
        this.sidebar = new SidebarComponent(page);
    }

    // ── DOM Selectors ────────────────────────────────────────────────────────

    private get jobCalendarInput() { return this.page.locator('.react-datepicker__input-container input'); }
    private get createJobScheduleButton() { return this.page.getByRole('button', { name: 'Create Job Schedule', exact: true }); }
    private get processButton() { return this.page.getByRole('button', { name: 'Process', exact: true }); }
    private get refreshJobsButton() { return this.page.locator('button[title="Refresh jobs"]'); }
    private get confirmYesButton() { return this.page.getByRole('button', { name: 'Yes', exact: true }); }
    private get noJobScheduleMessage() { return this.page.locator('text=/No job schedule on/'); }

    /** All job card elements on the page (each card has an h6 title, status label, etc.) */
    private get jobCards() { return this.page.locator('.card').filter({ has: this.page.locator('h6') }); }

    // ── Navigation ──────────────────────────────────────────────────────────

    /**
     * Navigate to Daily Schedule screen via top nav menu + sidebar.
     * Opens Operations Hub → Jobs Management, then selects DAILY from the sidebar.
     */
    async navigateViaNav(): Promise<void> {
        await this.hoverNavMenu(/Operations Hub/i);
        await this.clickNavLink(/Jobs Management/i, /job-schedule/i);
        await this.page.waitForLoadingToDisappear();
        await this.navigateViaSidebar();
    }

    /**
     * Navigate to Daily Schedule via the left sidebar.
     * Use this when already on the Jobs Management page.
     */
    async navigateViaSidebar(): Promise<string> {
        return this.sidebar.navigateTo('Jobs Management', 'DAILY');
    }

    // ── Calendar Input ──────────────────────────────────────────────────────

    /**
     * Input job calendar date (format: YYYY-MM-DD)
     */
    async inputJobCalendar(date: string): Promise<void> {
        await this.jobCalendarInput.click();
        await this.jobCalendarInput.clear();
        await this.jobCalendarInput.fill(date);
        await this.jobCalendarInput.press('Enter');
        await this.page.waitForLoadingToDisappear();
    }

    // ── Job Schedule Actions ────────────────────────────────────────────────

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
        await this.page.waitForLoadingToDisappear();
    }

    /**
     * Click the Refresh jobs button
     */
    async clickRefreshJobs(): Promise<void> {
        await this.refreshJobsButton.click();
        await this.page.waitForLoadingToDisappear();
    }

    // ── Job Card Status ─────────────────────────────────────────────────────

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
    /**
     * Per-job status as RENDERED on the Job Schedule screen.
     *
     * The chain is not a table — it is one `.card` per job whose text reads
     * "BILL_CHECK Status: Completed Schedule Time Type Automatic", which is why
     * tableCount is 0 on this screen. Measured 2026-09-11: all nine jobs
     * (BILL_CHECK, INVOICE_CHECK, COLLECTION_CREATE, COLLECTION_ACTIONS,
     * CANCEL_SUBSCRIPTION, CRDR_NOTES, CREDIT_LIMIT_ACTIONS, FUTURE_CANCEL,
     * FUTURE_PURCHASE) expose their status this way.
     *
     * This is the UI equivalent of the `job chain = BILL_CHECK=COMPLETED | ...`
     * line that ts-06-billing-run reads out of the database, so a billing run can
     * assert what an operator actually sees rather than only what the tables say.
     *
     * Cards that are not job cards (the header, the column legend) carry no
     * "Status:" and are skipped by the pattern rather than filtered by position,
     * which would break the moment a card is added.
     *
     * @returns JOB_NAME -> upper-cased status, e.g. { BILL_CHECK: 'COMPLETED' }
     */
    async jobStatuses(): Promise<Record<string, string>> {
        const out: Record<string, string> = {};
        const texts = await this.jobCards.allInnerTexts().catch(() => [] as string[]);
        for (const raw of texts) {
            const t = String(raw).replace(/\s+/g, ' ').trim();
            const m = t.match(/([A-Z][A-Z0-9_]{2,})\s+Status:\s*([A-Za-z_]+)/);
            if (m) out[m[1]] = m[2].toUpperCase();
        }
        return out;
    }

    async isJobListVisible(): Promise<boolean> {
        return (await this.jobCards.count()) > 0;
    }

    // ── Composite Flows ─────────────────────────────────────────────────────

    /**
     * Clear existing job schedule for a date via DB, then refresh the UI.
     * If job cards are visible, query DB for the schedule ID and delete it.
     */
    async clearExistingJobSchedule(
        jobScheduleDbHelper: JobScheduleDbHelper,
        date: string,
        testLogger: TestLogger
    ): Promise<void> {
        const hasJobs = await this.isJobListVisible();
        if (!hasJobs) {
            testLogger.log(`No existing job schedule found on UI for date ${date}. Skipping cleanup.`);
            return;
        }

        testLogger.log(`Existing job schedule found on UI for date ${date}. Cleaning up via DB...`);

        try {
            const jobSchedules = await jobScheduleDbHelper.getJobSchedule(date);
            testLogger.data('Job Schedules to delete', jobSchedules);

            for (const job of jobSchedules) {
                await jobScheduleDbHelper.deleteJobScheduleById(job.id);
                testLogger.log(`Deleted job schedule ID: ${job.id}`);
            }
        } catch (error) {
            testLogger.error('Failed to clean up job schedules via DB', String(error));
            throw error;
        }

        // Reload the page to reflect DB changes
        await this.page.reload();
        await this.page.waitForLoadState('networkidle').catch(() => { });
        await this.page.waitForLoadingToDisappear();;

        // Re-input the date to refresh the view
        await this.inputJobCalendar(date);
    }

    /**
     * Wait for all job cards to finish processing (no more Pending status).
     * Polls by clicking Refresh and checking statuses, up to maxRetries times.
     * 
     * @returns true if all jobs completed within the retry limit, false otherwise
     */
    async waitForAllJobsCompleted(
        testLogger: TestLogger,
        maxRetries: number = 10,
    ): Promise<boolean> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const hasPending = await this.hasAnyPendingJob();

            if (!hasPending) {
                testLogger.log(`All jobs completed after ${attempt} check(s).`);
                return true;
            }

            testLogger.log(`Attempt ${attempt}/${maxRetries}: Some jobs still Pending. Refreshing...`);
            await this.page.waitForTimeout(LONG_WAIT);
            await this.clickRefreshJobs();
        }

        testLogger.error(`Jobs did not complete within ${maxRetries} retries.`, '');
        return false;
    }
}