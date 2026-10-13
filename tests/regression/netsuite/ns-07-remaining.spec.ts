/**
 * NetSuite R2 — cross-cutting checks built from earlier specs' data, and the
 * cases that cannot run yet (each says exactly why, so nothing silently drops).
 */
import { test, expect } from '@playwright/test';
import { NsApi, parse } from '../../../helpers/netsuite/ns-api.helper';
import { actual, blocked, needsConfirmation, notApplicable, loadState, once } from '../../../helpers/netsuite/ns-record';

test.describe('NetSuite R2 — cross-cutting', () => {
  test('INV-013: every invoice-creation path sends entity and numeric tipoFactura', async ({ playwright }) => {
    const api = new NsApi(await playwright.request.newContext());
    const paths: [string, string, string | undefined][] = [
      ['manual (UI / manualInvoiceService)', '208886', loadState('inv208886')],
      ['first invoice of processAccountAndOrder', loadState('P1')?.account, loadState('P1')?.invoice],
      ['SYNC_INVOICE resend', loadState('N1')?.account, loadState('N1')?.invoice],
    ];
    const lines: string[] = []; const bad: string[] = [];
    for (const [label, account, invoice] of paths) {
      if (!account || !invoice) { lines.push(`${label}: no data (run ns-01/ns-02 first)`); bad.push(label); continue; }
      const req = parse((await api.activitiesFor(account, invoice, 'CREATE_INVOICE')).at(-1)?.request);
      const acc = await api.account(account);
      lines.push(`${label} ${invoice}: entity ${JSON.stringify(req?.invoice?.entity)} (partyId ${acc.partyId}), tipoFactura ${JSON.stringify(req?.invoice?.tipoFactura)}`);
      if (req?.invoice?.entity !== acc.partyId || req?.invoice?.tipoFactura !== 12) bad.push(label);
    }
    actual(`${lines.join(' | ')} | recurring BDOM job path: not covered — needs a billing-job slot (INV-001)`);
    expect(bad).toEqual([]);
    blocked(`3 of 4 paths OK (${lines.length} checked); the BDOM job path — the one at risk per handoff §4 (service-invoice had an older Engine) — still needs a billing-job slot`);
  });

  test('MAP-010: a Party Id change on the account is used by the next invoice', async ({ playwright }) => {
    const api = new NsApi(await playwright.request.newContext());
    const p1 = loadState('P1');
    if (!p1?.account) blocked('needs the ns-02 P1 contract (QA, no exemption)');
    const before = (await api.account(p1.account)).partyId;
    await api.setPartyId(p1.account, '61425');
    try {
      const id = await once('map010', () => api.manualInvoice(p1.account, [{ itemId: 'I_INT', serviceType: 'INTERNET', description: 'QA-NS-R2 MAP-010', quantity: 1, unitPrice: 1000 }]));
      const req = parse((await api.waitForActivity(p1.account, id, 'CREATE_INVOICE'))?.request);
      const old = parse((await api.activitiesFor(p1.account, p1.invoice, 'CREATE_INVOICE')).at(-1)?.request);
      actual(`${p1.account}: partyId ${before} → 61425; new invoice ${id} entity ${JSON.stringify(req?.invoice?.entity)}; earlier invoice ${p1.invoice} still sent as ${JSON.stringify(old?.invoice?.entity)}`);
      expect.soft(old?.invoice?.entity).toBe(before);
      expect(req?.invoice?.entity).toBe('61425');
    } finally {
      await api.setPartyId(p1.account, before);
    }
  });

  test('API-001: the invoice detail API returns the PDF of a new invoice', async () => {
    needsConfirmation('ISP-220 (RQ-13, Ready to deploy): the endpoint path and request/response are only in a Jira attachment, and the CRM gateway path is not documented. Ask Jeremy for the path, then this case can run');
  });

  test('INV-016: a double SYNC_INVOICE on one ERROR invoice creates one NetSuite invoice', async () => {
    blocked('needs an ERROR invoice on a contract NetSuite knows (only 0279497 qualifies and must not be resubmitted, handoff §6). New QA contracts always end in "contract not found"');
  });
});

test.describe('NetSuite R2 — cannot run yet', () => {
  const cases: [string, string, 'blocked' | 'confirm' | 'na', string][] = [
    ['CRN-004', 'bulk credit adjustments are sent to NetSuite', 'blocked', 'failed-row handling is pending a decision (R1) and the bulk file format for CoopeG was not provided'],
    ['PAY-002..005', 'underpayment / overpayment / group payment / arrangement', 'confirm', 'ISP-212/213 are REQUIREMENT PENDING — no expected behaviour to test against'],
    ['ACC-001..003', 'accounting (EBS) extract behaviour', 'confirm', 'ISP-207 (turn the EBS extract off) is UNDER ANALYSIS with no decision; an email says Energy only'],
    ['MIG-001', 'invoice / credit-note migration scope', 'confirm', 'ISP-209/211 migration scripts are one-off; ask Jeremy/PM whether they are in this regression'],
    ['PTY-001', 'Party ID bulk update', 'na', 'ISP-208 dropped: CoopeG updates party ids themselves'],
    ['CRM-002', 'a contract update through the API is applied', 'confirm', 'the update payload NetSuite/Coopeweb will send is not defined (only processAccountAndOrder MODIFY exists)'],
    ['AR-006', 'grace-period API', 'confirm', 'ISP-206 is WAITING CUSTOMER APPROVAL; endpoint/fields only in an attachment — confirm it is deployed'],
  ];
  for (const [id, title, kind, why] of cases) {
    test(`${id}: ${title}`, async () => {
      if (kind === 'blocked') blocked(why);
      else if (kind === 'confirm') needsConfirmation(why);
      else notApplicable(why);
    });
  }
});
