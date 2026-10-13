/**
 * NetSuite regression — API access to coopegsbx2.
 *
 * WHY ONE HELPER. Every NetSuite case reads the same four things: the account
 * (partyId, type), the invoice's sync outcome (Invoicing report — the GraphQL
 * InvoiceUnit type has NO financeSyncStatus / financeErrorMessage), the
 * Customer Activity rows (request = the exact NetSuite-bound JSON, response =
 * NetSuite's answer), and the credit notes. Writes go through the same two
 * doors the product uses: Core GraphQL (agent actions) and the CRM gateway
 * (what Coopeweb / NetSuite call).
 *
 * SAFETY.
 *  - Tenant is pinned: refuses to run unless TEST_ENV=coopegsbx2.
 *  - setCcpTime is the only tenant-wide write and needs NS_ALLOW_CLOCK=true.
 *  - Nothing here schedules jobs or touches invoice 0279497 (handoff §6).
 */
import { APIRequestContext } from '@playwright/test';

export const NS_TENANT = 'coopegsbx2';
export const DO_NOT_RESUBMIT = new Set(['0279497']);
/** example.com never delivers: invoice e-mails from tests must not reach CoopeG customers. */
export const QA_MAILBOX = 'qa.netsuite@example.com';
/** Accounts this suite creates are named QA-ANH-NS-*; only those may be edited. */
export const QA_ACCOUNT = /^QA-ANH-NS-/;

export interface Activity {
  id: string; entityId: string; apiName: string; activityDate: string;
  request: string | null; response: string | null; action?: string;
}
export interface InvoiceReportRow {
  id: string; accountId: string; invoiceDate: string; invoiceTotal: number; dueDate?: string;
  status: string; folioStatus: string | null; financeSyncStatus: string | null; financeErrorMessage: string | null;
}

function assertTenant(): void {
  if (process.env.TEST_ENV !== NS_TENANT) {
    throw new Error(`NetSuite helper refuses TEST_ENV='${process.env.TEST_ENV}' — it only runs on ${NS_TENANT}.`);
  }
}

/** GraphQL string literal (JSON escaping is valid GraphQL string escaping). */
const L = (v: string) => JSON.stringify(String(v));

/** AdjustmentInput fields whose values are GraphQL enums (written bare, not quoted). */
const ADJUSTMENT_ENUMS = new Set(['type', 'arType', 'taxRule', 'reason', 'source']);

/** Serialises a plain object as a GraphQL input literal; keys in `enums` are written bare. */
function gqlLiteral(v: unknown, enums: Set<string> = new Set(), key = ''): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(x => gqlLiteral(x, enums)).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${k}:${gqlLiteral(x, enums, k)}`).join(',')}}`;
  }
  if (typeof v === 'string') return enums.has(key) ? (/^[A-Z_]+$/.test(v) ? v : (() => { throw new Error(`bad enum ${key}=${v}`); })()) : JSON.stringify(v);
  return String(v);
}

export class NsApi {
  constructor(private request: APIRequestContext) { assertTenant(); }

  private get gqlUrl(): string { return process.env.GRAPH_URLS!; }
  private get crmUrl(): string { return process.env.CRM_GATEWAY_URL!; }

  // ── GraphQL ─────────────────────────────────────────────────────────────
  async gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await this.request.post(this.gqlUrl, { data: { query, variables }, timeout: 180_000 });
    const body = await res.json();
    if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e: any) => e.message).join(' | ')}`);
    return body.data;
  }

  async ccpDate(): Promise<string> {
    const d = await this.gql(`{ getCcpDateTime(dummy:"ns") { ccpTime } }`);
    return d.getCcpDateTime.ccpTime;
  }

  async setCcpDate(date: string): Promise<void> {
    if (process.env.NS_ALLOW_CLOCK !== 'true') {
      throw new Error('Clock moves are tenant-wide: set NS_ALLOW_CLOCK=true only inside a slot agreed with Jeremy.');
    }
    await this.gql(`mutation($d:Date){ setCcpTime(input:{ccpTime:$d}) { ccpTime } }`, { d: date });
  }

  async account(id: string): Promise<any> {
    const d = await this.gql(`{ getAccountById(input:{id:${L(id)}}) {
      id status type partyId accountCategory customAttributes { name value }
      taxExemptions { percent startDate endDate taxCertificate { id certificateNumber } } paymentProfiles { paymentTerm paymentMethod } } }`);
    return d.getAccountById;
  }

  async invoiceReport(id: string): Promise<InvoiceReportRow | undefined> {
    const d = await this.gql(`{ getInvoiceReport(page:1,size:5,filter:{id:${L(id)},startDate:"2000-01-01",endDate:"2099-12-31"}) {
      id accountId invoiceDate invoiceTotal dueDate status folioStatus financeSyncStatus financeErrorMessage } }`);
    return (d.getInvoiceReport ?? []).find((r: InvoiceReportRow) => r.id === id);
  }

  async invoiceReportByStatus(status: 'ERROR' | 'SUCCESS' | 'PENDING', accountId?: string): Promise<InvoiceReportRow[]> {
    const d = await this.gql(`{ getInvoiceReport(page:1,size:200,filter:{financeSyncStatus:${status}${accountId ? `,accountId:${L(accountId)}` : ''},startDate:"2000-01-01",endDate:"2099-12-31"}) {
      id accountId invoiceDate invoiceTotal status financeSyncStatus financeErrorMessage } }`);
    return d.getInvoiceReport ?? [];
  }

  async invoice(id: string): Promise<any> {
    const d = await this.gql(`{ getInvoiceUnitById(input:{id:${L(id)}}) {
      id accountId billUnitId type status invoiceType invoiceDate dueDate total due financeRefId financeVersion folioStatus paymentTerm invoiceNotes } }`);
    return d.getInvoiceUnitById;
  }

  async invoicesOf(accountId: string): Promise<any[]> {
    const d = await this.gql(`{ searchInvoiceUnits(page:1,size:100,filter:{accountId:${L(accountId)}}) {
      id accountId billUnitId type status invoiceType invoiceDate dueDate total due financeRefId financeVersion folioStatus } }`);
    return d.searchInvoiceUnits ?? [];
  }

  async activities(accountId: string, apiName?: string): Promise<Activity[]> {
    const d = await this.gql(`{ searchActivities(page:1,size:200,filter:{accountId:${L(accountId)}${apiName ? `,apiName:${L(apiName)}` : ''}}) {
      id entityId apiName action activityDate request response } }`);
    return d.searchActivities ?? [];
  }

  /** Activities for one entity (invoice / credit note), oldest first by A-number. */
  async activitiesFor(accountId: string, entityId: string, apiName?: string): Promise<Activity[]> {
    const all = await this.activities(accountId, apiName);
    const num = (a: Activity) => Number(String(a.id).replace(/\D/g, ''));
    return all.filter(a => a.entityId === entityId || a.entityId === entityId.replace(/^0+/, '')).sort((x, y) => num(x) - num(y));
  }

  /** Waits for an activity to appear (the sync may be asynchronous — ENV-004). */
  async waitForActivity(accountId: string, entityId: string, apiName: string, timeoutMs = 180_000): Promise<Activity | undefined> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const hit = (await this.activitiesFor(accountId, entityId, apiName)).pop();
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 10_000));
    }
    return undefined;
  }

  async creditNotesOf(accountId: string): Promise<any[]> {
    const d = await this.gql(`{ searchNotesUnits(page:1,size:100,filter:{accountId:${L(accountId)},startDate:"2000-01-01",endDate:"2099-12-31"}) {
      id type accountId status notesDate total notes invoiceId reasonDescription folioStatus financeSyncStatus financeErrorMessage } }`);
    return d.searchNotesUnits ?? [];
  }

  /** Manual invoice, as Bills > MANUAL BILLING does it. Returns the new invoice id. */
  async manualInvoice(accountId: string, lines: { itemId?: string; serviceType: string; description: string; quantity: number; unitPrice: number }[]): Promise<string> {
    const before = new Set((await this.invoicesOf(accountId)).map(i => i.id));
    const ccp = await this.ccpDate();
    const recs = lines.map(l => ({
      accountId, serviceType: l.serviceType, itemId: l.itemId, description: l.description,
      startDate: ccp, endDate: ccp, quantity: l.quantity, unitPrice: l.unitPrice,
      netAmount: l.quantity * l.unitPrice, grossAmount: l.quantity * l.unitPrice, discountAmount: 0,
    }));
    await this.gql(`mutation($i:ManualPreratedTxnInput!){ manualInvoiceService(input:$i) { id } }`, {
      i: { accountId, txnDate: ccp, billStartDate: ccp, billEndDate: ccp, scheduleDaily: false, returnBase64PDF: false, manualPreratedTxnRec: recs },
    });
    for (let i = 0; i < 18; i++) {
      const created = (await this.invoicesOf(accountId)).find(inv => !before.has(inv.id));
      if (created) return created.id;
      await new Promise(r => setTimeout(r, 10_000));
    }
    throw new Error(`manualInvoiceService on ${accountId}: no new invoice appeared within 3 min`);
  }

  /**
   * Input is sent INLINE, not as a $variable: with invoiceLines the server answers an empty
   * HTTP 400 to the variable form, while the same input written inline works (seen 2026-10-12).
   */
  async processAdjustment(input: Record<string, unknown>): Promise<any> {
    const d = await this.gql(`mutation{ processAdjustment(input:${gqlLiteral(input, ADJUSTMENT_ENUMS)}) { id invoiceId amount percent type arType taxRule reason refId requestActivityId } }`);
    return d.processAdjustment;
  }

  async syncInvoice(id: string): Promise<any> {
    if (DO_NOT_RESUBMIT.has(id)) throw new Error(`Invoice ${id} must not be resubmitted (handoff §6)`);
    const d = await this.gql(`mutation{ syncInvoice(input:{id:${L(id)}}) { id isError financeRefId financeVersion message statusCode } }`);
    return d.syncInvoice;
  }

  async regenerateInvoice(invoiceId: string): Promise<void> {
    await this.gql(`mutation($i:RegenerateInvoiceInput!){ regenerateInvoice(input:$i) { id } }`, { i: { invoiceId } });
  }

  /** EMAIL_INVOICE. Always to a non-deliverable QA address — test accounts carry real CoopeG mailboxes. */
  async emailInvoice(accountId: string, invoiceUnitId: string): Promise<void> {
    await this.gql(`mutation($i:SendInvoiceInput!){ sendInvoice(input:$i) { id } }`,
      { i: { accountId, invoiceUnitId, emailId: QA_MAILBOX } });
  }

  /** Sets (or clears, with '') the account's Party Id — only on QA-created accounts. */
  async setPartyId(accountId: string, partyId: string): Promise<void> {
    if (!QA_ACCOUNT.test(accountId)) throw new Error(`Refusing to edit partyId of ${accountId}: not a QA-created account`);
    await this.gql(`mutation($i:ModifyAccountInput!){ modifyAccount(input:$i) { id partyId } }`, { i: { id: accountId, partyId } });
  }

  /**
   * Replaces the tax exemption of a QA-created account (index 1). percent null = remove.
   * serviceTypes limits it to e.g. ['INTERNET'] (per-item exemption, MAP-012).
   */
  async setTaxExemption(accountId: string, percent: number | null, opts: { certificate?: string; serviceTypes?: string[] } = {}): Promise<any> {
    if (!QA_ACCOUNT.test(accountId)) throw new Error(`Refusing to edit exemptions of ${accountId}: not a QA-created account`);
    const ex = percent === null ? [] : [{
      index: 1, startDate: '2020-01-01', endDate: '2030-12-31', percent,
      ...(opts.certificate ? { taxCertificate: { certificateNumber: opts.certificate } } : {}),
      ...(opts.serviceTypes ? { serviceTypes: opts.serviceTypes.map((s, i) => ({ index: i + 1, serviceType: s })) } : {}),
    }];
    await this.gql(`mutation($i:ModifyAccountInput!){ modifyAccount(input:$i) { id } }`, { i: { id: accountId, taxExemptions: ex } });
    return (await this.account(accountId)).taxExemptions;
  }

  async accountItems(accountId: string, invoiceUnitId?: string): Promise<any> {
    const d = await this.gql(`{ getAccountItems(input:{accountId:${L(accountId)}${invoiceUnitId ? `,invoiceUnitId:${L(invoiceUnitId)}` : ''}}) { accountId accountItemsData { invoiceUnitId itemId name totalAmount } } }`);
    return d.getAccountItems;
  }

  async invoiceLines(id: string): Promise<any[]> {
    const d = await this.gql(`{ getInvoiceLinesById(id:${L(id)}) { index name itemId taxCode amount quantity unitPrice gross } }`);
    return d.getInvoiceLinesById ?? [];
  }

  // ── CRM gateway (Coopeweb / NetSuite inbound) ──────────────────────────
  async crm(path: string, body: unknown): Promise<{ status: number; json: any; text: string }> {
    const res = await this.request.post(`${this.crmUrl}/${path}`, { data: body, timeout: 300_000 });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status(), json, text };
  }
}

/** Parse an activity's request/response JSON, tolerating null and non-JSON text. */
export function parse(s: string | null | undefined): any {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return s; }
}
