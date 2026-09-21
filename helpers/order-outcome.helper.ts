import { TestLogger } from './test-logger';

/**
 * Did the NEW order actually PRODUCE a working prepaid contract?
 *
 * "The order reached COMPLETED" is not the same question. An order can complete
 * and still leave an account that can never be rated or billed — most commonly
 * with no `service_provision` METER row, which is silent at creation time and
 * only surfaces much later as "rating never happened". That has cost this suite
 * real time twice: the CRM gateway path creates an account in ~3s and never
 * attaches the meter, and the tariff scripts block on exactly the same missing
 * row.
 *
 * This is the checklist from point 3 of Huy's 2026-09-15 E2E guide, turned into
 * an assertion. Every item was verified against his own accounts ACT-100875 and
 * ACT-100878 on jasec-dev, 2026-09-15.
 *
 * ENTIRELY GraphQL — no browser, no DB, NO VPN. That is deliberate: TS-01 is a
 * Core UI test and adding a database dependency to it would make the suite's
 * entry point fail whenever the VPN is down, which is not what it is testing.
 *
 * THREE TRAPS THIS ENCODES:
 *
 *   1. `service_unit.provisioningId` IS NOT THE METER. It stays as the generated
 *      placeholder `prov-<account>-<order>` (e.g. `prov-ACT-100875-ORD-1583`),
 *      which looks plausible and is not what rating matches on. The meter lives
 *      in `searchServiceProvisioningData` as a row with `type: "METER"`.
 *      Asserting the meter against the service unit passes on an account that
 *      can never rate.
 *
 *   2. `getServiceUnitsByAccountId` RETURNS HISTORY. One service unit comes back
 *      once per state — ACT-100875 returns SVC-107778 twice, CLOSED with no
 *      bundle and ACTIVE with `B-100000-E`. Counting rows to count service units
 *      over-counts. Dedupe by id and keep the ACTIVE row.
 *
 *   3. Top-up price units accumulate. Every top-up adds a CLOSED
 *      `Prepaid_Subscription_Topup_ELEC` price unit, so "one price unit" is only
 *      true of the ACTIVE ones. Filter on status before counting.
 *
 * Owner: Anh Tran (QC).
 */

/** The prepaid energy price offer every JASEC Phase 1 subscription carries. */
export const PREPAID_ENERGY_PRICE_OFFER = 'P-100008';

/**
 * The four true-up discount offers that make the 0-30 kWh fixed charge work.
 * Missing any one of them means a sub-30 kWh cycle cannot be trued up to
 * 1,943.40 — the account bills wrongly and nothing says so at creation time.
 */
export const MIN_TRUEUP_DISCOUNT_OFFERS = [
  'KWH-MIN-TRUEUP',
  'KWH-CVG-MIN-TRUEUP',
  'ALP-MIN-TRUEUP',
  'ALP-CVG-MIN-TRUEUP',
] as const;

export interface PrepaidOrderOutcome {
  subscription: { id: string; status: string; category: string; name: string; creditProfileName: string | null } | null;
  serviceUnits: Array<{ id: string; type: string; status: string; provisioningId: string | null; bundleId: string | null }>;
  meterProvisions: Array<{ id: string; provisioningId: string; type: string }>;
  activePriceOffers: string[];
  activeDiscountOffers: string[];
  billUnits: Array<{ id: string; type: string; status: string; total: number }>;
  balances: Array<{ currencyId: string; amount: number }>;
}

export interface ExpectedOutcome {
  meter: string;
  /** Defaults to `Prepaid Energy Profile`; pass the E2E no-window profile when used. */
  creditProfileName?: string;
  bundleId?: string;
}

export class OrderOutcomeHelper {
  private static cachedToken: string | null = null;
  private readonly url: string;

  constructor(private logger?: TestLogger) {
    const url = process.env.EMBRIX_GRAPHQL_URL ?? process.env.GRAPH_URLS ?? '';
    if (!url) throw new Error('OrderOutcomeHelper: set EMBRIX_GRAPHQL_URL (or GRAPH_URLS).');
    this.url = url;
  }

  private async token(): Promise<string> {
    if (OrderOutcomeHelper.cachedToken) return OrderOutcomeHelper.cachedToken;
    const user = process.env.EMBRIX_USER;
    const pass = process.env.EMBRIX_PASSWORD;
    if (!user || !pass) throw new Error('EMBRIX_USER / EMBRIX_PASSWORD are required.');
    const d = await this.post(
      `{ userLogin(input: {userName: "${user}", password: "${pass}"}) { token } }`,
      false,
    );
    const t = d?.userLogin?.token;
    if (!t) throw new Error('userLogin returned no token');
    OrderOutcomeHelper.cachedToken = t;
    return t;
  }

  private async post(query: string, auth = true, attempts = 3): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${await this.token()}`;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let text: string;
      try {
        const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify({ query }) });
        text = await res.text();
      } catch (err) {
        lastErr = err;
        if (attempt === attempts) break;
        await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON from ${this.url}: ${text.slice(0, 300)}`);
      }
      if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors).slice(0, 500)}`);
      return body.data;
    }
    throw new Error(`transport failure after ${attempts} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`);
  }

  /** Read everything the order should have produced, in one pass. */
  async read(accountId: string): Promise<PrepaidOrderOutcome> {
    const d = await this.post(`{
      sub: getSubscriptionByAccountId(input:{id:"${accountId}"}) {
        id status category name creditProfileName }
      svc: getServiceUnitsByAccountId(input:{id:"${accountId}"}) {
        id type status provisioningId bundleId }
      pru: getPriceUnitsByAccountId(input:{id:"${accountId}"}) {
        id priceOfferId status }
      du: getDiscountUnitsByAccountId(input:{id:"${accountId}"}) {
        id discountOfferId status }
      bu: searchBillUnits(page:1, size:20, filter:{accountId:"${accountId}"}) {
        id type status total }
      prov: searchServiceProvisioningData(page:1, size:20,
             filter:{accountId:"${accountId}", serviceType: ELECTRICITY}) {
        provisioning { id provisioningId type } }
      bal: getBalanceUnitByAccountId(input:{id:"${accountId}"}) {
        balances { currencyId amount } }
    }`);

    // Trap 2: history rows. Keep the ACTIVE state of each service unit, falling
    // back to whatever came last for that id.
    const byId = new Map<string, any>();
    for (const s of d.svc ?? []) {
      if (!byId.has(s.id) || s.status === 'ACTIVE') byId.set(s.id, s);
    }

    return {
      subscription: (d.sub ?? [])[0] ?? null,
      serviceUnits: [...byId.values()],
      meterProvisions: (d.prov?.provisioning ?? []).filter((p: any) => p.type === 'METER'),
      activePriceOffers: (d.pru ?? []).filter((p: any) => p.status === 'ACTIVE').map((p: any) => p.priceOfferId),
      activeDiscountOffers: (d.du ?? []).filter((x: any) => x.status === 'ACTIVE').map((x: any) => x.discountOfferId),
      billUnits: d.bu ?? [],
      balances: d.bal?.balances ?? [],
    };
  }

  /**
   * The checklist. Returns the list of problems, empty when the order produced a
   * contract that can actually be topped up, rated and billed.
   */
  verify(outcome: PrepaidOrderOutcome, expected: ExpectedOutcome): string[] {
    const bad: string[] = [];
    const wantProfile = expected.creditProfileName ?? 'Prepaid Energy Profile';

    // ── subscription ──────────────────────────────────────────────────
    const sub = outcome.subscription;
    if (!sub) {
      bad.push('no subscription was created for this account');
    } else {
      if (sub.status !== 'ACTIVE') bad.push(`subscription ${sub.id} is ${sub.status}, expected ACTIVE`);
      if (sub.category !== 'PREPAID') bad.push(`subscription ${sub.id} is ${sub.category}, expected PREPAID`);
      /**
       * The credit profile is what makes balance-driven suspension work. An
       * account created with the wrong one looks perfect and can never be
       * suspended — this is the check that would have caught the legalEntity
       * mix-up that made every account we created unrepresentative.
       */
      if (sub.creditProfileName !== wantProfile) {
        bad.push(
          `subscription ${sub.id} carries credit profile "${sub.creditProfileName}", expected ` +
          `"${wantProfile}" — without it the account can never be suspended on balance`,
        );
      }
    }

    // ── one ELECTRICITY service unit ──────────────────────────────────
    const active = outcome.serviceUnits.filter((s) => s.status === 'ACTIVE');
    const electricity = active.filter((s) => s.type === 'ELECTRICITY');
    if (electricity.length !== 1) {
      bad.push(
        `expected exactly 1 ACTIVE ELECTRICITY service unit, found ${electricity.length} ` +
        `(${active.map((s) => `${s.id}:${s.type}`).join(', ') || 'none'})`,
      );
    }
    if (expected.bundleId && electricity[0] && electricity[0].bundleId !== expected.bundleId) {
      bad.push(`service unit ${electricity[0].id} carries bundle ${electricity[0].bundleId}, expected ${expected.bundleId}`);
    }

    // ── the meter (trap 1) ────────────────────────────────────────────
    const meters = outcome.meterProvisions.map((p) => p.provisioningId);
    if (!meters.includes(expected.meter)) {
      bad.push(
        `no service_provision METER row for meter ${expected.meter} — found [${meters.join(', ') || 'none'}]. ` +
        `This account can never be rated. NOTE the service unit's own provisioningId ` +
        `(${electricity[0]?.provisioningId ?? 'n/a'}) is the generated placeholder, not the meter.`,
      );
    }

    // ── pricing ───────────────────────────────────────────────────────
    const energyOffers = outcome.activePriceOffers.filter((p) => p === PREPAID_ENERGY_PRICE_OFFER);
    if (energyOffers.length !== 1) {
      bad.push(
        `expected exactly 1 ACTIVE price unit on ${PREPAID_ENERGY_PRICE_OFFER}, found ${energyOffers.length} ` +
        `(active offers: ${outcome.activePriceOffers.join(', ') || 'none'})`,
      );
    }

    const missingDiscounts = MIN_TRUEUP_DISCOUNT_OFFERS.filter((d) => !outcome.activeDiscountOffers.includes(d));
    if (missingDiscounts.length) {
      bad.push(
        `missing ACTIVE true-up discount unit(s): ${missingDiscounts.join(', ')} — ` +
        `without all four, a sub-30 kWh cycle cannot be trued up to the 1,943.40 fixed charge`,
      );
    }

    // ── a cycle is open, and the balance starts at zero ───────────────
    const pending = outcome.billUnits.filter((b) => b.status === 'PENDING');
    if (pending.length < 1) {
      bad.push(
        `no PENDING bill unit — the account has no open cycle to accrue into ` +
        `(bill units: ${outcome.billUnits.map((b) => `${b.id}:${b.type}/${b.status}`).join(', ') || 'none'})`,
      );
    }

    const crc = outcome.balances.find((b) => b.currencyId === 'CRC');
    if (!crc) {
      bad.push(`no CRC balance row (found: ${outcome.balances.map((b) => b.currencyId).join(', ') || 'none'})`);
    } else if (Math.round(crc.amount * 100) !== 0) {
      /**
       * A brand-new contract starts at exactly 0.00. Remember JASEC's inverted
       * sign convention: NEGATIVE is credit, positive is debt. A fresh account
       * showing anything but zero means it was not fresh.
       */
      bad.push(`CRC balance is ${crc.amount}, expected 0.00 on a newly created contract`);
    }

    return bad;
  }

  /** Read and verify in one call. Logs a readable summary either way. */
  async readAndVerify(accountId: string, expected: ExpectedOutcome): Promise<string[]> {
    const outcome = await this.read(accountId);
    const problems = this.verify(outcome, expected);
    this.logger?.data(`order outcome for ${accountId}`, {
      subscription: outcome.subscription,
      activeServiceUnits: outcome.serviceUnits.filter((s) => s.status === 'ACTIVE').map((s) => `${s.id}:${s.type}`),
      meters: outcome.meterProvisions.map((p) => p.provisioningId),
      activePriceOffers: outcome.activePriceOffers,
      activeDiscountOffers: outcome.activeDiscountOffers,
      billUnits: outcome.billUnits.map((b) => `${b.id}:${b.type}/${b.status}`),
      balances: outcome.balances,
      problems,
    });
    return problems;
  }
}
