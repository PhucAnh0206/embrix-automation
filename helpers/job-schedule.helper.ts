import { APIRequestContext } from '@playwright/test';
import { TestLogger } from './test-logger';

/**
 * JobScheduleHelper — create and run an Embrix job schedule over GraphQL.
 *
 * This is the trigger side of the JEPYP-230 notification suite. Everything the
 * runbook does with a hand-edited shell script lives here instead.
 *
 * THREE CONSTRAINTS THAT COST A RUN IF YOU GET THEM WRONG:
 *
 *  1. `scheduleDate` is an EXACT equality against each account's
 *     required_scheduledate. Not today, not the CCP date — the account's own
 *     date. Use NotificationDbHelper.getRequiredScheduleDate.
 *
 *  2. `job_schedule` is UNIQUE(schedulefrequency, scheduledate) and only DAILY
 *     and SCHEDULED exist, so a date has exactly TWO slots. `assertSlotFree`
 *     checks before you burn the attempt.
 *
 *  3. The CCP clock only moves FORWARD. Once a date is spent you cannot go back
 *     and re-run it, and the accounts billed by it have advanced a cycle.
 *
 * Note the two endpoints: login and setCcpTime go to `service-transactional`,
 * but createJobSchedule and processJobSchedule go to `service-proxy`. Sending a
 * schedule mutation to the transactional endpoint fails in a way that looks like
 * a permissions problem.
 */

export type JobType =
  | 'BILL_CHECK'
  | 'BILL_CC'
  | 'BILL'
  | 'INVOICE_CHECK'
  | 'CREDIT_LIMIT_ACTIONS'
  | 'CREATE_COLLECTION'
  | 'COLLECTION_ACTIONS'
  | 'EBS_EXTRACT';

export type ScheduleFrequency = 'DAILY' | 'SCHEDULED';

export interface JobSpec {
  type: JobType;
  /** Unique per schedule. Defaults to `${type}-${index}`. */
  name?: string;
  scheduleType?: 'AUTOMATIC' | 'MANUAL';
}

export interface CreateScheduleOptions {
  /** MUST equal the accounts' required_scheduledate, YYYY-MM-DD. */
  scheduleDate: string;
  jobs: JobSpec[];
  frequency?: ScheduleFrequency;
  scheduleName?: string;
  userId?: string;
}

export class JobScheduleHelper {
  private static cachedToken: string | null = null;

  private readonly transactionalUrl =
    process.env.GRAPH_URLS ?? process.env.GRAPHQL_URL ?? '';

  constructor(private request: APIRequestContext, private logger?: TestLogger) { }

  /**
   * Proxy endpoint, derived from the transactional one.
   *
   * Override with EMBRIX_PROXY_GRAPHQL_URL if a tenant does not follow the
   * `service-transactional` / `service-proxy` naming.
   */
  private get proxyUrl(): string {
    if (process.env.EMBRIX_PROXY_GRAPHQL_URL) return process.env.EMBRIX_PROXY_GRAPHQL_URL;
    if (!this.transactionalUrl) {
      throw new Error(
        'JobScheduleHelper: no GraphQL URL. Set GRAPHQL_URL or EMBRIX_PROXY_GRAPHQL_URL.',
      );
    }
    return this.transactionalUrl.replace('service-transactional', 'service-proxy');
  }

  private async getToken(): Promise<string> {
    if (JobScheduleHelper.cachedToken) return JobScheduleHelper.cachedToken;

    const username = process.env.EMBRIX_USER;
    const password = process.env.EMBRIX_PASSWORD;
    if (!username || !password) {
      throw new Error('EMBRIX_USER / EMBRIX_PASSWORD are required for API auth.');
    }

    // Same shape the Core UI sends: a plain query (not a mutation), field
    // `userName` (not `userId`), values inlined.
    const res = await this.request.post(this.transactionalUrl, {
      headers: { 'content-type': 'application/json' },
      data: {
        query: `{ userLogin(input: {userName: "${username}", password: "${password}"}) { token } }`,
      },
    });
    if (!res.ok()) {
      throw new Error(`userLogin failed HTTP ${res.status()}: ${await res.text()}`);
    }
    const body = await res.json();
    const token = body?.data?.userLogin?.token;
    if (!token) throw new Error(`userLogin returned no token: ${JSON.stringify(body.errors ?? body)}`);
    JobScheduleHelper.cachedToken = token;
    return token;
  }

  private async post(
    url: string,
    query: string,
    variables?: Record<string, unknown>,
    timeoutMs = 300_000,
  ) {
    const res = await this.request.post(url, {
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${await this.getToken()}`,
      },
      data: variables ? { query, variables } : { query },
      timeout: timeoutMs,
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 400)}`);
    }
    if (body.errors?.length) {
      throw new Error(`GraphQL error from ${url}: ${JSON.stringify(body.errors)}`);
    }
    return body.data;
  }

  /**
   * Create a schedule. Returns its id.
   *
   * One schedule carries jobs of several types — `job_schedule_list.type` is
   * per-row — so a mixed CHECK / CREDIT_CARD account set needs BILL_CHECK and
   * BILL_CC entries on the SAME schedule, not two schedules. You cannot create
   * two on one date and frequency anyway.
   */
  async createSchedule(opts: CreateScheduleOptions): Promise<string> {
    const frequency = opts.frequency ?? 'DAILY';

    // `job_schedule_list.name` is UNIQUE ACROSS THE WHOLE TABLE, not per
    // schedule — a plain `BILL_CHECK-1` succeeds once and then collides on every
    // later run with `duplicate key value violates unique constraint
    // "job_schedule_list__name"`. The runbook's script sidesteps this by
    // suffixing `date +%H%M%S`; a base-36 timestamp is the same trick with more
    // headroom.
    const runToken = Date.now().toString(36);
    const jobs = opts.jobs
      .map((j, i) => {
        const name = j.name ?? `${j.type}-${i + 1}-${runToken}`;
        const scheduleType = j.scheduleType ?? 'AUTOMATIC';
        return `{index:${i + 1} name:"${name}" type:${j.type} scheduleType:${scheduleType}}`;
      })
      .join(' ');

    const query = `mutation {
      createJobSchedule(input: {
        scheduleDate: "${opts.scheduleDate}"
        userId: "${opts.userId ?? 'sysadmin'}"
        scheduleFrequency: ${frequency}
        scheduleName: "${opts.scheduleName ?? 'DAILY'}"
        jobScheduleList: [${jobs}]
      }) { id }
    }`;

    const data = await this.post(this.proxyUrl, query);
    const id = data?.createJobSchedule?.id;
    if (!id) throw new Error(`createJobSchedule returned no id: ${JSON.stringify(data)}`);
    this.logger?.log(
      `created schedule ${id} on ${opts.scheduleDate} (${frequency}) ` +
      `with ${opts.jobs.map((j) => j.type).join(' -> ')}`,
    );
    return id;
  }

  /**
   * Run a schedule and return its terminal status.
   *
   * A status of ERROR is NOT automatically a failure: an account that crosses
   * its credit limit during billing throws `CURRENCY_CREDIT_LIMIT_EXCEEDED`
   * after its notifications have already been sent, so a `jobs_error` row next
   * to delivered mail is the correct outcome for Events 4+5. Assert on the
   * notifications, not on this.
   */
  async processSchedule(id: string, timeoutMs = 840_000): Promise<{ id: string; status: string }> {
    // Generous timeout: BILL_CHECK + INVOICE_CHECK runs for every account on the
    // date, not just the staged ones — 84 accounts on jasec-dev. The default
    // 300s is comfortably too short for a full population.
    const query = `mutation { processJobSchedule(input: { id: "${id}" }) { id status } }`;
    const data = await this.post(this.proxyUrl, query, undefined, timeoutMs);
    const result = data?.processJobSchedule;
    if (!result) throw new Error(`processJobSchedule returned nothing for ${id}`);
    this.logger?.log(`processed schedule ${id} -> ${result.status}`);
    return result;
  }

  /** Order matters: BILL_CHECK then INVOICE_CHECK. Reversed gives empty invoices. */
  static billingJobs(): JobSpec[] {
    return [{ type: 'BILL_CHECK' }, { type: 'INVOICE_CHECK' }];
  }

  /**
   * Billing for a mixed payment-method account set.
   *
   * `insert_jobs` splits on payment method: BILL_CHECK takes CHECK, BILL_CC
   * takes CREDIT_CARD. An account on the wrong one is silently not billed.
   */
  static billingJobsAllPaymentMethods(): JobSpec[] {
    return [{ type: 'BILL_CHECK' }, { type: 'BILL_CC' }, { type: 'INVOICE_CHECK' }];
  }

  /**
   * Suspension only. Event 5 comes from CREDIT_LIMIT_ACTIONS, NOT from
   * BILL_CHECK — runbook §6 implies otherwise and neither it nor any of the
   * /tmp scripts include this job, which is why suspension appeared not to fire.
   */
  static creditLimitActionsJobs(): JobSpec[] {
    return [{ type: 'CREDIT_LIMIT_ACTIONS' }];
  }
}
