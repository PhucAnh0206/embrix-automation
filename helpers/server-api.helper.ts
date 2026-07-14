import { APIRequestContext, expect } from '@playwright/test';
import { TestLogger } from './test-logger';

/**
 * ServerHelper — A helper class for orchestrating server-level operations.
 * Coordinates backend API actions such as date generation and CCP server time updates via GraphQL.
 */
export class ServerHelper {
    private request: APIRequestContext;
    private graphqlUrl = process.env.GRAPH_URLS ?? 'https://transactional.coopeg.embrix.org/graphql';
    private logger?: TestLogger;

    /**
     * @param request - Playwright's APIRequestContext for making API requests.
     * @param logger - Optional TestLogger instance for recording operation history.
     */
    constructor(request: APIRequestContext, logger?: TestLogger) {
        this.request = request;
        this.logger = logger;
    }

    /**
     * Generates a random future testing date and computes target date offsets.
     * Useful for time-travel verification scenarios without causing instant password expiry.
     * 
     * @returns Object containing the start date, first date of next month, and first date of next two months.
     */
    async generateRandomFutureDate(): Promise<{ startDate: string; nextMonthFirstDate: string; nextTwoMonthsFirstDate: string; nextThreeMonthsFirstDate: string; nextFourMonthsFirstDate: string; nextFiveMonthsFirstDate: string; }> {
        // 1. Get new random year (from next year to next 4 years) to avoid testing in December of the current year
        const nextYear = new Date().getFullYear() + 1;
        const randomYear = nextYear + Math.floor(Math.random() * 3);
        const randomMonth = Math.floor(Math.random() * 12); // 0 - 11
        const randomDay = Math.floor(Math.random() * 28) + 1; // 1 - 28 (apply for all month)
        const startDate = new Date(randomYear, randomMonth, randomDay);

        // 2. Get 1st date of the next month
        const nextMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);

        // 3. Get 1st date of the next 2 months
        const nextTwoMonths = new Date(startDate.getFullYear(), startDate.getMonth() + 2, 1);

        // 3. Get 1st date of the next 3 months
        const nextThreeMonths = new Date(startDate.getFullYear(), startDate.getMonth() + 3, 1);

        // 3. Get 1st date of the next 4 months
        const nextFourMonths = new Date(startDate.getFullYear(), startDate.getMonth() + 4, 1);

        // 3. Get 1st date of the next 5 months
        const nextFiveMonths = new Date(startDate.getFullYear(), startDate.getMonth() + 5, 1);

        // 4. Helper function to format date as yyyy-mm-dd
        const formatDate = (date: Date): string => {
            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const dd = String(date.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        };

        // 5. Return the results
        const result = {
            startDate: formatDate(startDate),
            nextMonthFirstDate: formatDate(nextMonth),
            nextTwoMonthsFirstDate: formatDate(nextTwoMonths),
            nextThreeMonthsFirstDate: formatDate(nextThreeMonths),
            nextFourMonthsFirstDate: formatDate(nextFourMonths),
            nextFiveMonthsFirstDate: formatDate(nextFiveMonths)
        };

        this.logger?.data('Generated Testing Dates', result);
        return result;
    }

    /**
     * Get current CCP time
     */
    async getCcpTime(): Promise<string> {
        this.logger?.api('POST', this.graphqlUrl);
        this.logger?.log('GraphQL query: getCcpDateTime');

        const response = await this.request.post(this.graphqlUrl, {
            data: {
                query: `
          query {
            getCcpDateTime(dummy: "Hello") {
              ccpTime
            }
          }
        `
            }
        });

        expect(response.ok()).toBeTruthy();
        const resBody = await response.json();
        if (!resBody.data || !resBody.data.getCcpDateTime) {
            this.logger?.error('GraphQL Response Error', resBody);
            throw new Error(`GraphQL query returned null data: ${JSON.stringify(resBody.errors || resBody)}`);
        }

        const ccpTime = resBody.data.getCcpDateTime.ccpTime;
        this.logger?.api('POST', this.graphqlUrl, response.status());
        this.logger?.data('CCP Time (get)', ccpTime);
        return ccpTime;
    }

    /**
     * Set CCP time
     */
    async setCcpTime(targetDate: string): Promise<string> {
        this.logger?.api('POST', this.graphqlUrl);
        this.logger?.log(`GraphQL mutation: setCcpTime → ${targetDate}`);

        const response = await this.request.post(this.graphqlUrl, {
            data: {
                query: `
          mutation {
            setCcpTime(input: { ccpTime: "${targetDate}" }) {
              ccpTime
            }
          }
        `
            }
        });

        expect(response.ok()).toBeTruthy();
        const resBody = await response.json();
        if (!resBody.data || !resBody.data.setCcpTime) {
            this.logger?.error('GraphQL Response Error', resBody);
            throw new Error(`GraphQL mutation returned null data: ${JSON.stringify(resBody.errors || resBody)}`);
        }

        const ccpTime = resBody.data.setCcpTime.ccpTime;
        this.logger?.api('POST', this.graphqlUrl, response.status());
        this.logger?.data('CCP Time (set)', ccpTime);
        return ccpTime;
    }

    /**
     * Set new CCP time and verify it matches
     * @param targetDate String format "YYYY-MM-DD"
     */
    async setAndVerifyCcpTime(targetDate: string): Promise<void> {
        // 1. Call API to set new CCP time for server
        const setTimeResult = await this.setCcpTime(targetDate);
        expect(setTimeResult).toBe(targetDate);

        // 2. Call API Get time independently to verify directly from server
        const currentServerTime = await this.getCcpTime();

        // 3. Compare the results to double check the Set action
        expect(currentServerTime).toBe(setTimeResult);
        this.logger?.log(`CCP time verified: ${currentServerTime}`);
    }
}