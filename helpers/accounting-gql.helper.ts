import { TestLogger } from './test-logger';

/**
 * AccountingGqlHelper — the EBS / ERP accounting extract over GraphQL.
 *
 * This is point 10 of Huy's 2026-09-15 end-to-end guide: after billing closes a
 * cycle and invoices it, `ebsExtract` posts the ledger entry — a batch of
 * double-entry journal lines fed to JASEC's Exactus ERP.
 *
 * WHY GRAPHQL AND NOT THE DATABASE. Everything the extract produces — header,
 * totals, status, every detail line with its GL accounts — is exposed to an
 * ordinary Core UI login through `searchEbsExtract` and
 * `getEbsExtractDetailsById`. So the read half of this suite needs nothing but
 * EMBRIX_USER / EMBRIX_PASSWORD: no browser, no VPN, safe from CI. Same choice,
 * and the same reasoning, as BillingGqlHelper.
 *
 * SIX THINGS THAT WILL COST YOU A RUN — every one verified on jasec-dev
 * 2026-09-15 against real batches 10013-10018:
 *
 *   1. AN EMPTY EXTRACT IS NOT AN ERROR. With no journals on the target date the
 *      mutation returns HTTP 200 and `{ id: "0", batchId: "No data found" }`.
 *      Nothing is created and nothing complains. A test that asserts only "the
 *      mutation succeeded" passes against an extract that did nothing at all.
 *      Use `isNoDataFound()` on every result, always.
 *
 *   2. THE DAY-BEFORE RULE IS CONDITIONAL. `ebsExtract` extracts the day BEFORE
 *      the `journalDate` you pass — but only when the ccp property
 *      `useGLCombination` is true. Read it in `core_revenue.ebs_extract_journal`:
 *      when the property is off, `v_revenuedate := in_revenuedate` and the date
 *      you pass IS the date extracted. jasec-dev has it ON, which is why the
 *      guide says "pass the day after". Never hardcode the offset — call
 *      `journalDateFor()` and let the live config decide.
 *
 *   3. `filePath` IS MASKED WHILE PENDING. `PGEbsExtractService.mapExtract` maps
 *      it as `status == PENDING ? null : record.filepath`. The file is on disk
 *      and the column is populated; GraphQL just will not show it until the
 *      batch is SENT or RESENT. A null `filePath` is NOT evidence that no file
 *      was written — check the database column for that.
 *
 *   4. `count` IS NOT THE NUMBER OF DETAIL ROWS. Batch 10017 reports count 51
 *      and has 3 detail lines: `count` is the source record count (the invoices
 *      swept in), while the detail rows are the aggregated GL postings. Asserting
 *      `count === details.length` passes by coincidence on small batches and
 *      fails on every real one.
 *
 *   5. THE TIE-OUT IS AN INVARIANT - AND IT FAILS. (Corrected 2026-10-08.) This
 *      point used to say "not an invariant, do not assert it", because detail
 *      totals matched the journals on 10013-10015 and not on 10016-10018. Every one
 *      of those gaps is exactly 2 x the batch's negative journal lines: the extract
 *      books credit lines with ABS(amount) (defect raised 2026-10-08). The tie-out
 *      is now asserted, on the signed net, in accounting/ts-04-extract-net-tie-out
 *      and in ts-06's run. `extractInvariants()` below checks only the SHAPE of a
 *      ledger - a ledger that drops every minus sign passes it.
 *
 *   6. RESEND KEEPS THE BATCH ID AND ADDS A HEADER. `resendEbsExtract` flips the
 *      old header to RESENT and creates a NEW one as SENT carrying the SAME
 *      batchId, count and filePath. So a batchId does not identify one header —
 *      `searchEbsExtract` returns both. Match on `id` when you mean one header.
 *
 * Owner: Anh Tran (QC).
 */

/** Sentinel batchId the mutation returns when the target date held no journals. */
export const NO_DATA_FOUND = 'No data found';

export type EbsExtractType =
  | 'ACCOUNT_RECEIVABLE' | 'ADJUSTMENT' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'DISPUTE'
  | 'EXCHANGE_RATE' | 'INVOICE' | 'INVOICE_LINE_ADJUSTMENT'
  | 'INVOICE_LINE_ADJUSTMENT_RECOGNITION' | 'INVOICE_RECOGNITION' | 'PAYMENT'
  | 'PAYMENT_REVERSAL' | 'PAYMENT_RECEIPTS' | 'PAYMENT_RECEIPTS_REVERSAL'
  | 'TOP_UP' | 'WRITE_OFF';

export type EbsExtractStatus = 'FAILED' | 'PENDING' | 'REGENERATED' | 'RESENT' | 'SENT';

/** What `ebsExtract` / `resendEbsExtract` hand back. Deliberately thin. */
export interface EbsExtractResult {
  id: string | null;
  batchId: string | null;
  batchName: string | null;
}

export interface EbsHeader {
  id: string;
  batchId: string;
  batchName: string;
  type: EbsExtractType;
  extractStatus: EbsExtractStatus;
  period: string;
  /** Last day of the accounting period the batch posts into. */
  accountingDate: string;
  /** The date actually extracted — `journalDate` minus the offset. */
  inputDate: string;
  createdDate: string;
  totalCreditAmount: number;
  totalDebitAmount: number;
  /** Source record count. NOT the detail row count — see note 4. */
  count: number;
  /** Masked to null while PENDING — see note 3. */
  filePath: string | null;
  /** Set only when the gateway path posted it (batchFinancialExtract=false). */
  externalRefId: string | null;
  currencyCode: string;
  category: string | null;
}

export interface EbsDetail {
  index: number;
  credit: number;
  debit: number;
  glAccount: string;
  glOffset: string;
  accountingCode: string;
  offsetAccountingCode: string;
  period: string;
  glDate: string;
  batchId: string;
  batchName: string;
  type: EbsExtractType;
}

/** True when the extract found nothing and silently did nothing. See note 1. */
export const isNoDataFound = (r: EbsExtractResult | null | undefined): boolean =>
  !r || r.batchId === NO_DATA_FOUND || r.id === '0';

/** `YYYY-MM-DD` shifted by `days`, done in UTC so no local timezone can bite. */
export const shiftDate = (isoDate: string, days: number): string => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

/** Last calendar day of the month `isoDate` falls in, as `YYYY-MM-DD`. */
export const endOfMonth = (isoDate: string): string => {
  const [y, m] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * Every structural rule that held on ALL 71 detail rows and all 18 headers on
 * jasec-dev, 2026-09-15. Returns the list of violations, empty when clean.
 *
 * These are the accounting invariants worth failing a build over: an unbalanced
 * entry, or one with no account to post to, is a broken ledger feed regardless
 * of which tenant or period produced it.
 */
export function extractInvariants(header: EbsHeader, details: EbsDetail[]): string[] {
  const bad: string[] = [];
  const money = (n: number) => Math.round(n * 100) / 100;

  // Double entry, at the header. Exposed directly by GraphQL.
  if (money(header.totalDebitAmount) !== money(header.totalCreditAmount)) {
    bad.push(
      `header ${header.id} (batch ${header.batchId}) does not balance: ` +
      `debit ${header.totalDebitAmount} vs credit ${header.totalCreditAmount}`,
    );
  }

  if (!details.length) {
    bad.push(`header ${header.id} (batch ${header.batchId}) has no detail rows`);
    return bad;
  }

  // Double entry, per row: each detail line carries both sides of one posting.
  for (const d of details) {
    if (money(d.credit) !== money(d.debit)) {
      bad.push(`batch ${header.batchId} line ${d.index}: credit ${d.credit} != debit ${d.debit}`);
    }
    if (!d.glAccount || !d.glOffset) {
      bad.push(`batch ${header.batchId} line ${d.index}: missing glAccount/glOffset`);
    }
    if (d.glAccount && d.glAccount === d.glOffset) {
      bad.push(
        `batch ${header.batchId} line ${d.index}: glAccount === glOffset (${d.glAccount}) — ` +
        `an entry posting to and from the same account moves nothing`,
      );
    }
    if (d.batchId !== header.batchId) {
      bad.push(`batch ${header.batchId} line ${d.index}: detail carries batchId ${d.batchId}`);
    }
  }

  // Header totals are the sum of the batch's own lines.
  const sumDebit = money(details.reduce((a, d) => a + Number(d.debit ?? 0), 0));
  const sumCredit = money(details.reduce((a, d) => a + Number(d.credit ?? 0), 0));
  if (sumDebit !== money(header.totalDebitAmount)) {
    bad.push(
      `header ${header.id} (batch ${header.batchId}) debit total ${header.totalDebitAmount} ` +
      `!= sum of its ${details.length} lines (${sumDebit})`,
    );
  }
  if (sumCredit !== money(header.totalCreditAmount)) {
    bad.push(
      `header ${header.id} (batch ${header.batchId}) credit total ${header.totalCreditAmount} ` +
      `!= sum of its ${details.length} lines (${sumCredit})`,
    );
  }

  return bad;
}

export class AccountingGqlHelper {
  private static cachedToken: string | null = null;
  private readonly url: string;

  constructor(private logger?: TestLogger) {
    const url = process.env.EMBRIX_GRAPHQL_URL ?? process.env.GRAPH_URLS ?? '';
    if (!url) throw new Error('AccountingGqlHelper: set EMBRIX_GRAPHQL_URL (or GRAPH_URLS).');
    this.url = url;
  }

  private async token(): Promise<string> {
    if (AccountingGqlHelper.cachedToken) return AccountingGqlHelper.cachedToken;
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
    AccountingGqlHelper.cachedToken = t;
    return t;
  }

  /**
   * POST, retrying TRANSPORT failures only — the endpoint drops sockets under a
   * burst of reads. A GraphQL `errors` payload is a real answer and is thrown
   * straight away; retrying a bad query would only hide it.
   *
   * MUTATIONS get ONE attempt whatever `attempts` says. A socket dropped after
   * the server acted still looks like a transport failure here, and retrying
   * `ebsExtract` / `resendEbsExtract` would post to JASEC's live ledger again.
   */
  private async post(query: string, auth = true, attempts = 3): Promise<any> {
    if (/^\s*mutation\b/.test(query)) attempts = 1;
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

  private static readonly HEADER_FIELDS = `
    id batchId batchName type extractStatus period accountingDate inputDate createdDate
    totalCreditAmount totalDebitAmount count filePath externalRefId currencyCode category`;

  /** Extract headers, newest first. `page` is 1-based. */
  async searchExtracts(
    page = 1,
    size = 50,
    filter?: { type?: EbsExtractType; extractStatus?: EbsExtractStatus; batchId?: string; period?: string },
  ): Promise<EbsHeader[]> {
    const parts: string[] = [];
    if (filter?.type) parts.push(`type: ${filter.type}`);
    if (filter?.extractStatus) parts.push(`extractStatus: ${filter.extractStatus}`);
    if (filter?.batchId) parts.push(`batchId: ${JSON.stringify(filter.batchId)}`);
    if (filter?.period) parts.push(`period: ${JSON.stringify(filter.period)}`);
    const f = parts.length ? `, filter:{${parts.join(', ')}}` : '';
    const d = await this.post(
      `{ searchEbsExtract(page:${page}, size:${size}, sort: createdDate_DESC${f}) { ${AccountingGqlHelper.HEADER_FIELDS} } }`,
    );
    return d.searchEbsExtract ?? [];
  }

  /** The GL lines of one extract. Takes the HEADER id, not the batchId. */
  async getDetails(headerId: string): Promise<EbsDetail[]> {
    const d = await this.post(`{ getEbsExtractDetailsById(input:{id:${JSON.stringify(headerId)}}) {
        index credit debit glAccount glOffset accountingCode offsetAccountingCode
        period glDate batchId batchName type
      } }`);
    return d.getEbsExtractDetailsById ?? [];
  }

  /** One ccp property, straight from the tenant. Cached per process. */
  private propCache = new Map<string, string | null>();
  async ccpProperty(name: string): Promise<string | null> {
    if (this.propCache.has(name)) return this.propCache.get(name)!;
    const d = await this.post(`{ getCcpPropertyByName(name:${JSON.stringify(name)}) { property value } }`);
    const v = d?.getCcpPropertyByName?.value ?? null;
    this.propCache.set(name, v);
    return v;
  }

  async isFlagOn(name: string): Promise<boolean> {
    return String(await this.ccpProperty(name)).trim().toLowerCase() === 'true';
  }

  /**
   * How many days `ebsExtract` looks BACK from the `journalDate` you pass.
   *
   * 1 when `useGLCombination` is true (jasec-dev, and the reason the guide says
   * "pass the day after"), 0 otherwise. Derived from the live tenant rather than
   * assumed, because a hardcoded 1 silently extracts the wrong day the moment
   * the property is flipped — and this whole feature is a one-day offset.
   */
  async extractOffsetDays(): Promise<number> {
    return (await this.isFlagOn('useGLCombination')) ? 1 : 0;
  }

  /** The `journalDate` to pass so that `targetDate` is the day actually extracted. */
  async journalDateFor(targetDate: string): Promise<string> {
    return shiftDate(targetDate, await this.extractOffsetDays());
  }

  /** Current simulated clock, `YYYY-MM-DD`. */
  async ccpDate(): Promise<string> {
    const d = await this.post(`{ getCcpDateTime(dummy: "accounting") { ccpTime } }`);
    return String(d?.getCcpDateTime?.ccpTime ?? '').slice(0, 10);
  }

  /**
   * Run the accounting extract. MUTATING and effectively irreversible: it
   * consumes the target day's journals, flips them to POSTED and stamps them
   * with the new batch id.
   *
   * `journalDate` is the RAW argument — pass `journalDateFor(target)` unless you
   * mean to test the offset itself.
   */
  async ebsExtract(journalDate: string, type: EbsExtractType = 'INVOICE'): Promise<EbsExtractResult[]> {
    this.logger?.log(`ebsExtract(journalDate:"${journalDate}", type:${type})`);
    const d = await this.post(
      `mutation { ebsExtract(input:{journalDate:${JSON.stringify(journalDate)}, type: ${type}}) { id batchId batchName } }`,
    );
    const out: EbsExtractResult[] = d?.ebsExtract ?? [];
    this.logger?.data('ebsExtract result', out);
    return out;
  }

  /**
   * Re-send an existing batch. Creates a NEW header as SENT carrying the same
   * batchId and flips the original to RESENT — see note 6.
   */
  async resendEbsExtract(headerId: string, batchId?: string, reExtract = false): Promise<EbsExtractResult[]> {
    const b = batchId ? `, batchId:${JSON.stringify(batchId)}` : '';
    const d = await this.post(
      `mutation { resendEbsExtract(input:{id:${JSON.stringify(headerId)}${b}, reExtract:${reExtract}}) { id batchId batchName } }`,
    );
    return d?.resendEbsExtract ?? [];
  }
}
