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
    private static cachedToken: string | null = null;

    /**
     * @param request - Playwright's APIRequestContext for making API requests.
     * @param logger - Optional TestLogger instance for recording operation history.
     */
    constructor(request: APIRequestContext, logger?: TestLogger) {
        this.request = request;
        this.logger = logger;
    }

    /**
     * Get (and cache) a Bearer token by calling the userLogin GraphQL mutation.
     * Since 2026-07 the core GraphQL endpoint requires authentication for every
     * call — including previously-anonymous ones like setCcpTime. Credentials
     * come from EMBRIX_USER / EMBRIX_PASSWORD (same as the browser login).
     * Token is cached per-process; the sandbox session lives long enough for
     * a full test run.
     */
    private async getToken(): Promise<string> {
        if (ServerHelper.cachedToken) return ServerHelper.cachedToken;

        const username = process.env.EMBRIX_USER;
        const password = process.env.EMBRIX_PASSWORD;
        if (!username || !password) {
            throw new Error('EMBRIX_USER / EMBRIX_PASSWORD env vars are required for API auth.');
        }

        // Mirror the shape the Core UI sends: plain `{ userLogin(input: {...}) { ... } }`
        // query (not a mutation), input field is `userName` (not `userId`), values inlined.
        const response = await this.request.post(this.graphqlUrl, {
            headers: { 'content-type': 'application/json' },
            data: {
                query: `{ userLogin(input: {userName: "${username}", password: "${password}"}) { token } }`,
            },
        });

        if (!response.ok()) {
            throw new Error(`userLogin failed with HTTP ${response.status()}: ${await response.text()}`);
        }
        const body = await response.json();
        const token = body?.data?.userLogin?.token;
        if (!token) {
            throw new Error(`userLogin returned no token: ${JSON.stringify(body.errors || body)}`);
        }
        ServerHelper.cachedToken = token;
        this.logger?.log('ServerHelper: acquired Bearer token via userLogin');
        return token;
    }

    private async authHeaders(): Promise<Record<string, string>> {
        return { Authorization: `Bearer ${await this.getToken()}` };
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
            headers: await this.authHeaders(),
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
            headers: await this.authHeaders(),
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
    /**
     * Warn loudly when a caller rewinds the clock.
     *
     * The CCP clock is TENANT-GLOBAL and frozen, and the runbook is explicit that
     * moving it backward can corrupt billing-cycle state. Several specs set fixed
     * past dates on purpose (ts-03 wants 2026-07-15), so this does NOT throw —
     * but a silent rewind is how a shared clock parked at 2026-11-09 ends up back
     * in July midway through someone else's session, which is very hard to
     * attribute after the fact.
     *
     * If you are writing a new spec: derive the target from the CURRENT clock and
     * only move forward.
     */
    private async warnIfBackward(targetDate: string): Promise<void> {
        try {
            const current = (await this.getCcpTime()).slice(0, 10);
            if (targetDate < current) {
                const msg =
                    `CCP REWIND: ${current} -> ${targetDate}. The clock is tenant-global and ` +
                    `moving it backward can corrupt cycle state. If this is not deliberate, ` +
                    `derive the target from the current clock instead.`;
                console.warn(`\n[ServerHelper] ${msg}\n`);
                this.logger?.log(msg);
            }
        } catch {
            // Never let the guard break the operation it is guarding.
        }
    }

    async setAndVerifyCcpTime(targetDate: string): Promise<void> {
        await this.warnIfBackward(targetDate);
        // 1. Call API to set new CCP time for server
        const setTimeResult = await this.setCcpTime(targetDate);
        expect(setTimeResult).toBe(targetDate);

        // 2. Verify with a small retry loop.
        // Post-security-patch (2026-07), jasec-dev's setCcpTime is occasionally
        // eventually-consistent: the mutation returns the target date but a
        // very-quick follow-up getCcpDateTime can return a stale value for
        // ~1-2 seconds before stabilizing. Retry a few times before failing.
        const maxAttempts = 5;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const currentServerTime = await this.getCcpTime();
            if (currentServerTime === setTimeResult) {
                this.logger?.log(
                    `CCP time verified: ${currentServerTime}` +
                    (attempt > 1 ? ` (attempt ${attempt}/${maxAttempts})` : '')
                );
                return;
            }
            if (attempt === maxAttempts) {
                // Final attempt — let expect throw with full mismatch details
                expect(currentServerTime).toBe(setTimeResult);
            }
            this.logger?.log(
                `CCP time not yet consistent (got ${currentServerTime}, want ${setTimeResult}); ` +
                `retrying (attempt ${attempt}/${maxAttempts - 1})…`
            );
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}