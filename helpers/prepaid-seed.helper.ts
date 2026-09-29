import { TestLogger } from './test-logger';

/**
 * Seed a JASEC prepaid contract over GraphQL — account, order, meter — in a
 * couple of seconds instead of the Core UI wizard's ~2.2 minutes.
 *
 * This is point 3 of Huy's 2026-09-15 E2E guide. It is the THIRD creation path
 * in this suite and the only one that is both fast and rateable:
 *
 *   Core UI wizard   ~2.2 min   attaches the meter   needs a browser
 *   CRM gateway      ~3 s       NO METER, silently   HTTP 200 + SUCCESS anyway
 *   this helper      ~3 s       attaches the meter   no browser
 *
 * USE IT to seed a test that needs a rateable account and is not itself testing
 * account creation through the UI. TS-01 must keep using the wizard — that is
 * the customer-facing path and it is what TS-01 exists to cover.
 *
 * THREE THINGS THAT COST HUY TIME AND WILL COST YOU THE SAME — from the guide,
 * reproduced here because each one fails in a way that does not name its cause:
 *
 *   1. DO NOT SEND `userId` ON createAccount. `account.userid` carries a unique
 *      index, so the SECOND account created with "congeroadmin" dies on a
 *      duplicate-key error that says nothing about userId.
 *
 *   2. THE METER GOES IN THE SERVICE'S `provisioningList`, not on the account
 *      afterwards. That is what writes `core_engine.service_provision`, which is
 *      the row rating matches an MDR meter against. `service_unit.provisioningid`
 *      stays as the generated placeholder `prov-<account>-<order>` — that is
 *      normal, and it is NOT the meter.
 *
 *   3. `effectiveDate` CANNOT PREDATE THE SIMULATED CLOCK. A back-dated order is
 *      refused with BACKDATED_EFFECTIVE_DATE. This is why a zero-length first
 *      cycle cannot be avoided by back-dating — you have to move the clock
 *      FORWARD after creating the account instead.
 *
 * Verify the result with OrderOutcomeHelper rather than trusting the mutations:
 * they can all succeed and still leave an account that cannot be rated.
 *
 * Owner: Anh Tran (QC).
 */

export interface SeedPrepaidOptions {
  /** Meter id. Must be unique across all history — use `uniqueRunSuffix()`. */
  meter: string;
  /** Customer id. Also unique across history. */
  customerId: string;
  /** Display name for the account. Tag it so it can be found and cleaned up. */
  name: string;
  /** `YYYY-MM-DD`. Must be >= the CCP clock. Defaults to the live CCP date. */
  effectiveDate?: string;
  /** Defaults to `Prepaid Energy Profile`. Pass the no-window profile to test suspension by day. */
  creditProfileName?: string;
  bundleId?: string;
  email?: string;
  /**
   * The NISE, as the JEPYP-231 Create Account screen stores it: in the
   * account's `clientId`. Omitted by default, which is why seeded accounts never
   * hit the order_clientid_fkey failure that screen-created accounts do (every
   * system-generated order copies account.clientId, and order.clientid is a
   * foreign key to account(id)). Pass it to reproduce a screen-shaped account.
   */
  clientId?: string;
  /**
   * Account and subscription category. Defaults to PREPAID, which is Phase 1.
   *
   * POSTPAID is here to mirror an account shape without touching the original:
   * `core_config.multi_rating` routes usage to a rating service by
   * (serviceType, subscriptionCategory), so a category with no row there has no
   * rating path at all. Seeding a matched pair isolates category as the only
   * variable.
   */
  category?: 'PREPAID' | 'POSTPAID';
}

export interface SeededPrepaidAccount {
  accountId: string;
  orderId: string;
  meter: string;
  effectiveDate: string;
}

/**
 * The server ANSWERED and said no - a GraphQL `errors` array on an HTTP 2xx.
 * Kept distinct from transport, HTTP and parse failures so a caller can treat a
 * refusal as a result without also swallowing "the VPN dropped".
 */
export class GraphQlBusinessError extends Error {}

export class PrepaidSeedHelper {
  private static cachedToken: string | null = null;
  private readonly url: string;

  constructor(private logger?: TestLogger) {
    const url = process.env.EMBRIX_GRAPHQL_URL ?? process.env.GRAPH_URLS ?? '';
    if (!url) throw new Error('PrepaidSeedHelper: set EMBRIX_GRAPHQL_URL (or GRAPH_URLS).');
    this.url = url;
  }

  private async token(): Promise<string> {
    if (PrepaidSeedHelper.cachedToken) return PrepaidSeedHelper.cachedToken;
    const user = process.env.EMBRIX_USER;
    const pass = process.env.EMBRIX_PASSWORD;
    if (!user || !pass) throw new Error('EMBRIX_USER / EMBRIX_PASSWORD are required.');
    const d = await this.post(`{ userLogin(input: {userName: "${user}", password: "${pass}"}) { token } }`, false);
    const t = d?.userLogin?.token;
    if (!t) throw new Error('userLogin returned no token');
    PrepaidSeedHelper.cachedToken = t;
    return t;
  }

  private async post(query: string, auth = true): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${await this.token()}`;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify({ query }) });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON from ${this.url}: ${text.slice(0, 300)}`);
    }
    if (body.errors?.length) {
      const detail = JSON.stringify(body.errors).slice(0, 600);
      // A non-2xx carrying `errors` is auth or infrastructure (401, 5xx), not a refusal.
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.url}, GraphQL error: ${detail}`);
      throw new GraphQlBusinessError(`GraphQL error: ${detail}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.url}: ${text.slice(0, 300)}`);
    return body.data;
  }

  /** Current simulated clock, `YYYY-MM-DD`. */
  async ccpDate(): Promise<string> {
    const d = await this.post(`{ getCcpDateTime(dummy: "seed") { ccpTime } }`);
    return String(d?.getCcpDateTime?.ccpTime ?? '').slice(0, 10);
  }

  /** Create the account. Returns the account id. */
  private async createAccount(o: SeedPrepaidOptions): Promise<string> {
    const email = o.email ?? 'anh.tran@congerotechnology.com';
    // NOTE: no `userId` field — see trap 1.
    const d = await this.post(`mutation { createAccount(input:{
      currency:"CRC", type: RESIDENTIAL, accountCategory: ${o.category ?? 'PREPAID'},
      customerSegment: B2C, salesChannel: NONE, marketSegment: NONE, subType: NONE,
      name:"${o.name}", customerId:"${o.customerId}",${o.clientId ? ` clientId:"${o.clientId}",` : ''}
      contacts:[{roles:[BILLING], firstName:"QA", lastName:"${o.customerId}", email:"${email}"}],
      addresses:[{roles:[BILLING], street:"Avenida 2 Occidental", city:"Cartago",
                  state:"Cartago", country:"CRI", postalCode:"30101"}],
      billingProfiles:[{billingDom:1, billingFrequency: MONTHLY, invoiceType: SUMMARY,
                        invoiceDelivery: EMAIL, paymentProfileId:"PRIMARY"}],
      paymentProfiles:[{paymentMethod: CHECK, paymentTerm:"NET_30"}]
    }){ id } }`);
    const id = d?.createAccount?.id;
    if (!id) throw new Error('createAccount returned no id');
    return id;
  }

  /** Create the NEW order carrying the meter, then submit it. */
  private async createAndSubmitOrder(
    accountId: string,
    o: SeedPrepaidOptions,
    effectiveDate: string,
  ): Promise<string> {
    const bundleId = o.bundleId ?? 'B-100000-E';
    const profile = o.creditProfileName ?? 'Prepaid Energy Profile';

    // The meter goes in provisioningList — see trap 2.
    const created = await this.post(`mutation { createOrder(input:{
      type: NEW, accountId:"${accountId}", userId:"congeroadmin",
      effectiveDate:"${effectiveDate}",
      subscriptions:[{index:1, subscriptionName:"Primary", subscriptionCategory: ${o.category ?? 'PREPAID'},
                      initialTerm:1, initialTermUnit: MONTHS, renewalTerm:1,
                      renewalTermUnit: MONTHS, creditProfileName:"${profile}"}],
      services:[{index:1, serviceType: ELECTRICITY, action: ADD, bundleId:"${bundleId}",
                 subscriptionName:"Primary",
                 provisioningList:[{index:1, provisioningId:"${o.meter}", type:"METER",
                                    effectiveDate:"${effectiveDate}"}]}]
    }){ id status } }`);

    const orderId = created?.createOrder?.id;
    if (!orderId) throw new Error('createOrder returned no id');

    await this.post(`mutation { updateOrderStatus(input:{
      id:"${orderId}", status: SUBMITTED, userId:"congeroadmin", executeFutureOrderNow:true
    }){ id status } }`);

    return orderId;
  }

  /**
   * Full seed: account + order + meter, submitted.
   *
   * `effectiveDate` defaults to the CCP clock because it cannot be earlier
   * (trap 3) and a future date leaves the subscription not yet effective.
   */
  async seed(o: SeedPrepaidOptions): Promise<SeededPrepaidAccount> {
    const effectiveDate = o.effectiveDate ?? (await this.ccpDate());
    const started = Date.now();

    const accountId = await this.createAccount(o);
    this.logger?.log(`seeded account ${accountId} (${o.customerId})`);

    const orderId = await this.createAndSubmitOrder(accountId, o, effectiveDate);
    this.logger?.log(
      `seeded order ${orderId} on ${accountId}, meter ${o.meter}, effective ${effectiveDate} ` +
      `— ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );

    return { accountId, orderId, meter: o.meter, effectiveDate };
  }

  /**
   * Put credit on the account. JASEC's sign convention is INVERTED: a positive
   * `amount` here credits the customer, and the balance then reads NEGATIVE.
   * Mis-signing this is the single most common JASEC mistake.
   */
  async topUp(accountId: string, amount: number): Promise<void> {
    await this.post(`mutation { subscriptionTopUp(input:{
      accountId:"${accountId}", userId:"congeroadmin", amount: ${amount},
      serviceType: ELECTRICITY, validityTerm: 1, validityTermUnit: MONTHS,
      applyPayment: false
    }){ id } }`);
    this.logger?.log(`topped up ${accountId} by ${amount} CRC`);
  }

  /**
   * Replay a usage batch — the recovery half of a credit breach.
   *
   * `perfBatchId` is `<mdr file name>-ELECPP-1`, e.g.
   * `MDR_PREPAGO_20260914-070000.csv-ELECPP-1`. Use `perfBatchIdFor()`.
   */
  async reprocessUsage(perfBatchId: string): Promise<{
    ratingResult: string; totalRecCount: number; successRecCount: number;
    failureRecCount: number; suspendedRecCount: number;
  }> {
    const d = await this.post(`mutation { processUsageRecords(input:{
      perfBatchId:"${perfBatchId}", reProcessRecs: true
    }){ ratingResult totalRecCount successRecCount failureRecCount suspendedRecCount } }`);
    const r = d?.processUsageRecords;
    this.logger?.data('processUsageRecords', r);
    return r;
  }

  /** The perfBatchId for an MDR file name. Verified against 594 processed rows. */
  static perfBatchIdFor(mdrFileName: string): string {
    return `${mdrFileName}-ELECPP-1`;
  }

  /**
   * Move the simulated clock. TENANT-GLOBAL — every session on this tenant sees
   * it, so only call it from a gated, mutating spec that says it will.
   */
  async setCcpDate(date: string): Promise<string> {
    const d = await this.post(`mutation { setCcpTime(input:{ccpTime:"${date}"}) { ccpTime } }`);
    const got = String(d?.setCcpTime?.ccpTime ?? '').slice(0, 10);
    this.logger?.log(`CCP clock -> ${got}`);
    return got;
  }

  /**
   * Close the account's current cycle and produce a bill unit.
   *
   * ⚠️ From the guide: this closes the cycle AT THE SIMULATED CLOCK and opens a
   * new one, and it can bill twice on an account that was already billed. Only
   * call it on an account the test itself created.
   */
  async runPendingBill(accountId: string): Promise<{ id: string; billTotal: number; status: string } | null> {
    const d = await this.post(`mutation { runPendingBill(input:{accountId:"${accountId}"}) {
      id billTotal status } }`);
    const r = d?.runPendingBill ?? null;
    this.logger?.data('runPendingBill', r);
    return r;
  }

  /** Invoice a closed bill unit. Returns the invoice id, or null if refused. */
  async invoiceAccount(accountId: string, billUnitId: string): Promise<string | null> {
    try {
      const d = await this.post(`mutation { invoiceAccount(input:{
        accountId:"${accountId}", billUnitId:"${billUnitId}"}) { id } }`);
      const id = d?.invoiceAccount?.id ?? null;
      this.logger?.log(`invoiceAccount(${billUnitId}) -> ${id ?? 'no invoice'}`);
      return id;
    } catch (err) {
      /**
       * A refusal is a RESULT here, not a crash. The 0-30 kWh true-up bill units
       * are exactly the ones INVOICE_CHECK has been observed to reject, so the
       * caller needs to see "refused, and here is why" rather than an exception.
       *
       * Only a refusal. A VPN drop, a 401 or a 5xx used to land here too and be
       * reported as INVOICE_CHECK rejecting the bill - an infrastructure failure
       * dressed up as a product finding. Those are rethrown.
       */
      if (!(err instanceof GraphQlBusinessError)) throw err;
      this.logger?.log(`invoiceAccount(${billUnitId}) REFUSED: ${(err as Error).message.slice(0, 300)}`);
      return null;
    }
  }
}
