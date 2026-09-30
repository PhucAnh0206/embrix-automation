import { TestLogger } from './test-logger';

/**
 * BillingGqlHelper — read invoices and account statements over GraphQL.
 *
 * WHY GRAPHQL AND NOT THE DATABASE. The two existing billing spikes read
 * `core_engine` directly, which means they need the AWS VPN. They don't have to:
 * `service-transactional` exposes the entire invoice document — header, lines,
 * tax lines and printed totals — to an ordinary Core UI login. Everything here
 * therefore runs with nothing but EMBRIX_USER / EMBRIX_PASSWORD, including from
 * CI, and survives the VPN dropping (which it did twice while this was written).
 *
 * READ-ONLY BY CONSTRUCTION. Every call is a query, never a mutation. No clock
 * move, no job_schedule slot, no staged account. Safe to run at any time against
 * a shared tenant.
 *
 * FOUR THINGS THAT COST AN HOUR IF YOU GET THEM WRONG — all found the hard way:
 *
 *   1. `page` is 1-BASED. `page:0` fails with `ERROR: OFFSET must not be
 *      negative`, which reads like a server fault rather than a bad argument.
 *
 *   2. `invoiceSummaryTotal` is an ARRAY, not an object. Treating it as an
 *      object yields `undefined` silently, and every arithmetic assertion then
 *      "fails" against a number that was never read. `summaryTotal()` below
 *      normalises it so no caller has to remember.
 *
 *   3. The tax amount field is `amount`. There is no `taxAmount` — asking for
 *      one is a schema validation error, not an empty value.
 *
 *   4. Invoice line `name` comes in TWO formats: plain (`ENERGIA`) and
 *      pipe-composite (`ENERGIA|KWH|30|0`). Matching only the plain form misses
 *      ~95% of the population. Use `lineName()`, and take the kWh from the
 *      structured `quantity` field — never from the digits inside the name.
 */

export interface InvoiceLine {
  index: number;
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  gross: number;
  taxCode: string;
}

export interface InvoiceTax {
  index: number;
  taxCode: string;
  /** BOM = ICB (1.75%), IVA = IVA (13%). */
  taxCategory: string;
  taxType: string;
  taxableAmount: number;
  exemptAmount: number;
  amount: number;
  taxRate: number;
}

export interface InvoiceDoc {
  id: string;
  accountId: string;
  total: number;
  due: number;
  invoiceDate: string;
  dueDate: string;
  /** Bill period this invoice covers. `startDate` keys the cycle accumulator. */
  startDate: string;
  endDate: string;
  status: string;
  invoiceSummaryList: InvoiceLine[];
  invoiceTaxList: InvoiceTax[];
  invoiceSummaryTotal: Array<{ summarySubTotal: number; taxSubTotal: number; total: number }>;
}

export interface AccumulatorRow {
  accumulatorId: string;
  amount: number;
  /** Matches the invoice's bill-period `startDate`. */
  startDate: string;
  /** One day past the invoice period end, by convention. */
  endDate: string;
}

export interface StatementLine {
  lineReferenceId: string;
  accountId: string;
  lineType: string;
  lineDate: string;
  invoiceId: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  openingBalance: number;
  amount: number;
  closingBalance: number;
  subTotal: number | null;
  taxes: number | null;
  status: string;
  currency: string;
}

/** First segment of a line name, so plain and pipe-composite forms both work. */
export const lineName = (n: string | null | undefined): string =>
  String(n ?? '').split('|')[0].trim().toUpperCase();

/** `invoiceSummaryTotal` is an array — never index it by hand at the call site. */
export const summaryTotal = (inv: InvoiceDoc) =>
  (Array.isArray(inv.invoiceSummaryTotal) ? inv.invoiceSummaryTotal[0] : inv.invoiceSummaryTotal) ?? null;

/**
 * Billed kWh for the cycle. Null when the invoice has no ENERGIA line.
 *
 * SUM THE BLOCKS. Invoice lines are split per TARIFF BLOCK, encoded in the
 * composite name as `ENERGIA|KWH|<from>|<to>` (`0` as the upper bound means
 * unbounded), and each block carries only ITS OWN slice of the consumption:
 *
 *     ENERGIA|KWH|0|30      qty   30
 *     ENERGIA|KWH|30|200    qty  170
 *     ENERGIA|KWH|200|0     qty  800     -> cycle total 1000
 *
 * VERIFIED, do not change on inspection of a single invoice. Checked against
 * `balance_unit_accumulators.KWH` — the authoritative cycle consumption — for
 * all 17 accounts billed on 2026-09-09:
 *
 *     SUM matched the accumulator on 17 of 17
 *     MAX matched on 0 of 17
 *
 * An earlier version of this function used `max()`, on the mistaken reading that
 * the top block carried the whole cycle. It does not. That error under-reported
 * consumption by exactly the lower blocks (typically 200 kWh), which pushed
 * invoices into a band below their real one and produced four false "tax applied
 * below the threshold" defects. Cross-checked against the team's own verified
 * rating case TC-44 (ACT-100599, 1000 kWh): blocks 30 + 170 + 800 = 1000.
 */
export const energiaKwh = (inv: InvoiceDoc): number | null => {
  const qs = (inv.invoiceSummaryList ?? [])
    .filter((x) => lineName(x.name) === 'ENERGIA')
    .map((x) => Number(x.quantity));
  return qs.length ? qs.reduce((a, b) => a + b, 0) : null;
};

export class BillingGqlHelper {
  private static cachedToken: string | null = null;
  private readonly url: string;

  constructor(private logger?: TestLogger) {
    const url = process.env.EMBRIX_GRAPHQL_URL ?? process.env.GRAPH_URLS ?? '';
    if (!url) throw new Error('BillingGqlHelper: set EMBRIX_GRAPHQL_URL (or GRAPH_URLS).');
    this.url = url;
  }

  private async token(): Promise<string> {
    if (BillingGqlHelper.cachedToken) return BillingGqlHelper.cachedToken;
    const user = process.env.EMBRIX_USER;
    const pass = process.env.EMBRIX_PASSWORD;
    if (!user || !pass) throw new Error('EMBRIX_USER / EMBRIX_PASSWORD are required.');
    // Same shape the Core UI sends: a plain query (not a mutation), field
    // `userName` (not `userId`), values inlined.
    const d = await this.post(
      `{ userLogin(input: {userName: ${JSON.stringify(user)}, password: ${JSON.stringify(pass)}}) { token } }`,
      false,
    );
    const t = d?.userLogin?.token;
    if (!t) throw new Error('userLogin returned no token');
    BillingGqlHelper.cachedToken = t;
    return t;
  }

  /**
   * POST with retry on TRANSPORT failures only.
   *
   * A band sweep makes one `getAccountById` call per account — hundreds in a
   * run — and the endpoint intermittently closes the socket under that, which
   * surfaces as `TypeError: fetch failed / SocketError: other side closed` and
   * aborts the whole spec mid-suite. Two full runs were lost to it before this
   * was added.
   *
   * Only transport errors are retried. A GraphQL `errors` payload is a real
   * answer from the server and is thrown immediately — retrying a bad query
   * would just hide it.
   */
  private async post(query: string, auth = true, attempts = 3): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${await this.token()}`;

    let lastTransportError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let text: string;
      try {
        const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify({ query }) });
        text = await res.text();
      } catch (err) {
        lastTransportError = err;
        if (attempt === attempts) break;
        // 250ms, 500ms — the socket drops are brief.
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
    throw new Error(
      `transport failure after ${attempts} attempts to ${this.url}: ` +
      `${(lastTransportError as Error)?.message ?? String(lastTransportError)}`,
    );
  }

  /** One page of invoices, headers plus lines plus taxes. `page` is 1-based. */
  async searchInvoices(page = 1, size = 200): Promise<InvoiceDoc[]> {
    const d = await this.post(`{ searchInvoiceUnits(page:${page}, size:${size}) {
        id accountId total due invoiceDate dueDate startDate endDate status
        invoiceSummaryTotal { summarySubTotal taxSubTotal total }
        invoiceSummaryList { index name quantity unitPrice amount gross taxCode }
        invoiceTaxList { index taxCode taxCategory taxType taxableAmount exemptAmount amount taxRate }
      } }`);
    return d.searchInvoiceUnits ?? [];
  }

  async getInvoice(id: string): Promise<InvoiceDoc> {
    const d = await this.post(`{ getInvoiceUnitById(input:{id:"${id}"}) {
        id accountId total due invoiceDate dueDate startDate endDate status
        invoiceSummaryTotal { summarySubTotal taxSubTotal total }
        invoiceSummaryList { index name quantity unitPrice amount gross taxCode }
        invoiceTaxList { index taxCode taxCategory taxType taxableAmount exemptAmount amount taxRate }
      } }`);
    return d.getInvoiceUnitById;
  }

  /**
   * Account category — PREPAID or POSTPAID. Cached, because a band sweep asks
   * for the same handful of accounts repeatedly.
   *
   * WHY EVERY BILLING ASSERTION NEEDS THIS. The JASEC tax thresholds (ICB above
   * 100 kWh, IVA above 280) are a **prepaid** rule. Measured over all 1,453
   * invoices carrying an ENERGIA line: prepaid at 0-30 kWh is 1379/1379 untaxed,
   * while postpaid at 0-30 kWh is 41/41 taxed. A band assertion that does not
   * filter on category reports the postpaid population as 41 product defects.
   */
  private catCache = new Map<string, string>();
  async accountCategory(accountId: string): Promise<string> {
    const hit = this.catCache.get(accountId);
    if (hit) return hit;
    const d = await this.post(`{ getAccountById(input:{id:"${accountId}"}) { id accountCategory } }`);
    const cat = d?.getAccountById?.accountCategory ?? 'UNKNOWN';
    this.catCache.set(accountId, cat);
    return cat;
  }

  /** Keep only invoices whose account is in `category`. */
  async filterByAccountCategory(invoices: InvoiceDoc[], category = 'PREPAID'): Promise<InvoiceDoc[]> {
    const out: InvoiceDoc[] = [];
    for (const inv of invoices) {
      if ((await this.accountCategory(inv.accountId)) === category) out.push(inv);
    }
    return out;
  }

  /**
   * Cycle accumulators for an account — the values the RATING ENGINE actually
   * reads when deciding whether a tax threshold is met.
   *
   * READ THIS BEFORE BANDING AN INVOICE BY ITS OWN kWh. The JASEC thresholds are
   * configured in `core_config.config_tax_product_taxes` against the **KWH
   * accumulator**, not against the invoice:
   *
   *     BOM  1.75%   accumulatorid KWH   min 100   max 1750
   *     IVA 13.00%   accumulatorid KWH   min 280   max null
   *
   * AN ACCOUNT HAS ONE ROW PER CYCLE, AND SOMETIMES SEVERAL PER CYCLE. Collapsing
   * them to a single number is wrong in two different ways, both observed:
   *
   *   ACT-100164 carries KWH 2634.21 for 2026-07-15 and KWH 83.78 for 2027-12-01.
   *   Keeping "the" accumulator kept 83.78 and made its 2,634 kWh invoice look
   *   like it had billed 30x more than the cycle accumulated.
   *
   *   ACT-100084 carries THREE KWH rows in the same window — 30, 170 and 386.7 —
   *   which must be SUMMED to reach the 586.7 its invoice billed.
   *
   * Match on `startDate`, which equals the invoice's bill-period `startDate`. The
   * end dates differ by convention: an accumulator window ends 2026-09-01 where
   * the invoice period ends 2026-08-31.
   *
   * NOTE THE ARGUMENT NAME. It is `input:{id:...}` and it takes the ACCOUNT id,
   * despite the field being called `id` — passing `accountId` is rejected with
   * "missing required fields '[id]'".
   */
  private accumCache = new Map<string, AccumulatorRow[] | null>();

  async getAccumulatorRows(accountId: string): Promise<AccumulatorRow[] | null> {
    if (this.accumCache.has(accountId)) return this.accumCache.get(accountId)!;
    // NO catch. "No balance unit" is not an error: the resolver returns null data
    // (QueryResolver.getBalanceUnitByAccountId: `found ? map(found) : null`), and
    // normaliseAccumulators turns that into null below. What a catch-all used to
    // swallow was transport, auth and schema failures - and callers then banded
    // the invoice on its own kWh, so a network blip silently moved an invoice to
    // a different band. Those now propagate, and are not cached.
    const d = await this.post(`{ getBalanceUnitByAccountId(input:{id:"${accountId}"}) {
        accountId accumulators { accumulatorId amount startDate endDate }
      } }`);
    const out = this.normaliseAccumulators(d?.getBalanceUnitByAccountId?.accumulators);
    this.accumCache.set(accountId, out);
    return out;
  }

  private normaliseAccumulators(list: unknown): AccumulatorRow[] | null {
    if (!Array.isArray(list)) return null;
    return list.map((a: any) => ({
      accumulatorId: String(a.accumulatorId),
      amount: Number(a.amount ?? 0),
      startDate: String(a.startDate ?? ''),
      endDate: String(a.endDate ?? ''),
    }));
  }

  /**
   * kWh accumulated in the cycle an invoice covers, or null when this account has
   * no accumulator for that period.
   *
   * Null is a real answer and must not be treated as zero — it means the cycle is
   * unknown, so any threshold judgement about that invoice is unsound. Callers
   * should fall back to the invoice's own kWh and skip cycle-dependent rules.
   */
  async cycleKwhForPeriod(accountId: string, periodStart: string): Promise<number | null> {
    const rows = await this.getAccumulatorRows(accountId);
    if (!rows || !periodStart) return null;
    const hit = rows.filter((r) => r.accumulatorId === 'KWH' && r.startDate === periodStart);
    return hit.length ? hit.reduce((a, r) => a + r.amount, 0) : null;
  }

  /**
   * Category + accumulators for many accounts in ONE round trip per chunk, using
   * GraphQL aliases. Populates the same caches the single-account methods read,
   * so callers can mix the two freely.
   *
   * WHY THIS EXISTS. A band sweep needs both facts for ~100 accounts. Done one at
   * a time that is 200 sequential requests, which takes minutes and is exactly the
   * load that makes the endpoint drop sockets mid-run (see `post`). Batched at 25
   * it is 8 requests.
   *
   * Chunk stays modest deliberately — a single oversized aliased document is
   * rejected outright, and one bad account id would then void the whole batch.
   */
  async primeAccounts(accountIds: string[], chunk = 25): Promise<void> {
    const todo = [...new Set(accountIds)].filter(
      (id) => !this.catCache.has(id) || !this.accumCache.has(id),
    );
    for (let i = 0; i < todo.length; i += chunk) {
      const slice = todo.slice(i, i + chunk);
      const body = slice.map((id, n) => `
        c${n}: getAccountById(input:{id:"${id}"}) { id accountCategory }
        b${n}: getBalanceUnitByAccountId(input:{id:"${id}"}) {
          accountId accumulators { accumulatorId amount startDate endDate }
        }`).join(' ');
      let d: any;
      try {
        d = await this.post(`{ ${body} }`);
      } catch {
        // One unresolvable id fails the whole document. Fall back to singles for
        // this chunk rather than losing the other 24.
        for (const id of slice) {
          await this.accountCategory(id).catch(() => undefined);
          await this.getAccumulatorRows(id).catch(() => undefined);
        }
        continue;
      }
      slice.forEach((id, n) => {
        this.catCache.set(id, d?.[`c${n}`]?.accountCategory ?? 'UNKNOWN');
        this.accumCache.set(id, this.normaliseAccumulators(d?.[`b${n}`]?.accumulators));
      });
    }
  }

  /** Estado de Cuenta. Newest line first. */
  async getAccountStatement(accountId: string, page = 1, size = 50): Promise<StatementLine[]> {
    const d = await this.post(`{ getAccountStatement(page:${page}, size:${size}, accountId:"${accountId}") {
        lineReferenceId accountId lineType lineDate invoiceId invoiceDate dueDate
        openingBalance amount closingBalance subTotal taxes status currency
      } }`);
    return d.getAccountStatement ?? [];
  }

  /**
   * Invoices whose billed kWh falls in [lo, hi], scanning up to `maxPages`.
   *
   * Scans rather than filters because `InvoiceUnitFilter` has no consumption
   * field — kWh lives on a line, not the header.
   */
  async findInvoicesInBand(
    lo: number,
    hi: number,
    maxPages = 8,
    size = 200,
    /**
     * Stop as soon as this many matches are in hand. Playwright re-runs
     * `beforeAll` after a failing test, so an unbounded scan here is paid two or
     * three times in a run with failures — 600 invoices fetched to assert on 25.
     * Pass the sample size and the scan stops at the first page that satisfies it.
     */
    enough = Infinity,
  ): Promise<InvoiceDoc[]> {
    const out: InvoiceDoc[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.searchInvoices(page, size);
      if (!batch.length) break;
      for (const inv of batch) {
        const k = energiaKwh(inv);
        if (k !== null && k >= lo && k <= hi) out.push(inv);
      }
      this.logger?.log(`band [${lo}, ${hi}] — page ${page}: ${out.length} matches so far`);
      if (out.length >= enough) break;
    }
    return out;
  }
}
