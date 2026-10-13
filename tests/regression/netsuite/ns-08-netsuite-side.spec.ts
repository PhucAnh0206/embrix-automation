/**
 * NetSuite R2 — the NetSuite side: does the record really exist in CoopeG's
 * sandbox with the customer, amounts, taxes, department and class Embrix sent?
 *
 * Read-only. Uses the session saved by ns-98-netsuite-login.spec.ts (a person
 * signs in once, with MFA). Records are opened by their NetSuite internal id,
 * which Embrix stores as Finance Ref Id (invoices) / response data.id (credits).
 *
 * These tests carry the SAME case ids as the Embrix-side checks in ns-01/ns-03;
 * the CSV reporter combines both halves into one row.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { NsApi, parse } from '../../../helpers/netsuite/ns-api.helper';
import { openRecord, NETSUITE_STATE, DEFAULT_NAMES, NsRecord } from '../../../helpers/netsuite/netsuite-ui.helper';
import { round2 } from '../../../helpers/netsuite/ns-oracle';
import { TD } from '../../../helpers/netsuite/ns-data';
import { actual, blocked, loadState } from '../../../helpers/netsuite/ns-record';

test.use({ storageState: fs.existsSync(NETSUITE_STATE) ? NETSUITE_STATE : { cookies: [], origins: [] } });

const ACC = TD.DEFAULT.account;
const sum = (r: NsRecord) => `NetSuite ${r.url}: #${r.field('INVOICE #') ?? r.field('CREDIT MEMO #') ?? '?'} customer ${r.field('CUSTOMER')} total ${r.field('TOTAL')} tax ${r.field('TOTAL DE IMPUESTOS')} memo ${r.field('MEMO')} contrato ${r.field('CPGT CONTRATO')} dept ${r.field('DEPARTMENT')} class ${r.field('CLASS')} loc ${r.field('LOCATION')}`;

test.describe('NetSuite R2 — records in the NetSuite sandbox', () => {
  let api: NsApi;
  let inv: any; let invRec: NsRecord | undefined;

  test.beforeAll(async ({ playwright, browser }) => {
    api = new NsApi(await playwright.request.newContext());
    const id = loadState('inv208886');
    inv = id ? await api.invoice(id) : undefined;
    if (inv?.financeRefId && fs.existsSync(NETSUITE_STATE)) {
      const ctx = await browser.newContext({ storageState: NETSUITE_STATE });
      invRec = await openRecord(await ctx.newPage(), 'invoice', inv.financeRefId).catch(() => undefined);
      await ctx.close();
    }
  });

  const need = () => {
    if (!fs.existsSync(NETSUITE_STATE)) blocked('no NetSuite session — run ns-98-netsuite-login.spec.ts --headed once');
    if (!inv?.financeRefId) blocked('needs the synced ns-01 invoice (state inv208886)');
    if (!invRec?.found) blocked(`could not open NetSuite invoice ${inv?.financeRefId}${invRec ? ` (${invRec.url})` : ''}`);
  };

  test('INV-006: the invoice exists in NetSuite under its Finance Ref Id with Finance Version as its number', async () => {
    need();
    actual(`${sum(invRec!)}; Embrix ref ${inv.financeRefId} version ${inv.financeVersion}`);
    expect(invRec!.field('INVOICE #')).toBe(inv.financeVersion);
  });

  test('INV-003: NetSuite shows the same customer, contract, dates, memo and totals as Embrix', async () => {
    need();
    const r = invRec!;
    actual(sum(r));
    expect.soft(r.ids, 'customer internal id = partyId 74003').toContain(TD.DEFAULT.party);
    expect.soft(r.field('CPGT CONTRATO')).toBe(ACC);
    expect.soft(r.field('MEMO')).toBe('Telecomunicaciones SEP-2027');
    expect.soft(r.field('DATE')).toBe('01/09/2027');
    expect.soft(r.field('DUE DATE')).toBe('16/09/2027');
    expect.soft(r.money('TOTAL DE IMPUESTOS')).toBe(1300);
    expect(r.money('TOTAL')).toBe(round2(Number(inv.total)));
  });

  test('MAP-006: NetSuite links the invoice to customer 74003 (the account partyId)', async () => {
    need();
    actual(`customer "${invRec!.field('CUSTOMER')}", linked ids ${invRec!.ids.join(',')}`);
    expect(invRec!.ids).toContain(TD.DEFAULT.party);
  });

  test('MAP-001: NetSuite shows the DEFAULT department / class / location', async () => {
    need();
    const r = invRec!;
    actual(`department "${r.field('DEPARTMENT')}", class "${r.field('CLASS')}", location "${r.field('LOCATION')}"`);
    expect([r.field('DEPARTMENT'), r.field('CLASS'), r.field('LOCATION')]).toEqual([DEFAULT_NAMES.department, DEFAULT_NAMES.class, DEFAULT_NAMES.location]);
  });

  test('MAP-004: NetSuite lines — I_INT at IVA 13%, CR / 911 as "No Sujeto"', async () => {
    need();
    const l = invRec!.lines;
    actual(l.map(s => s.split('\t').filter(x => x.trim()).slice(0, 10).join(' / ')).join(' | '));
    expect.soft(l.find(s => s.startsWith('I_INT')) ?? '').toMatch(/IVA 13%/);
    expect.soft(l.find(s => s.startsWith('I_IMP_CR')) ?? '').toMatch(/No Sujeto/);
    expect(l.find(s => s.startsWith('I_IMP_911')) ?? '').toMatch(/No Sujeto/);
  });

  test('CRN-001: the 10% credit memo exists in NetSuite, for customer 74003, applied to the invoice', async ({ page }) => {
    need();
    const ids = loadState('once:cn:first')?.value;
    const act = ids?.actId ? (await api.activities(ACC, 'CREATE_CREDIT_NOTES')).find(a => a.id === ids.actId) : undefined;
    const nsId = parse(act?.response)?.data?.id;
    if (!nsId) blocked(`no NetSuite id for the ns-03 credit note (${JSON.stringify(ids)})`);
    const r = await openRecord(page, 'creditMemo', String(nsId).replace(/\.0$/, ''));
    actual(`${sum(r)}; applied to ${inv.financeVersion}: ${r.allText.includes(inv.financeVersion)}`);
    expect.soft(r.found).toBe(true);
    expect.soft(r.ids).toContain(TD.DEFAULT.party);
    expect.soft(r.money('TOTAL')).toBe(1147.5);
    expect(r.allText).toContain(inv.financeVersion);
  });

  test('ENG-006-01: NetSuite credit memo customer = account partyId 74003', async ({ page }) => {
    need();
    const ids = loadState('once:cn:first')?.value;
    const act = ids?.actId ? (await api.activities(ACC, 'CREATE_CREDIT_NOTES')).find(a => a.id === ids.actId) : undefined;
    const nsId = parse(act?.response)?.data?.id;
    if (!nsId) blocked('no NetSuite id for the ns-03 credit note');
    const r = await openRecord(page, 'creditMemo', String(nsId).replace(/\.0$/, ''));
    actual(`credit memo ${r.url}: customer "${r.field('CUSTOMER')}", linked ids ${r.ids.join(',')}`);
    expect(r.ids).toContain(TD.DEFAULT.party);
  });

  test('INV-014: the multi-line invoice in NetSuite has I_INT, I_TV and both levies with the Embrix totals', async ({ page }) => {
    need();
    const id = loadState('once:multi208886')?.value;
    const m = id ? await api.invoice(id) : undefined;
    if (!m?.financeRefId) blocked(`multi-line invoice not synced (${id})`);
    const r = await openRecord(page, 'invoice', m.financeRefId);
    actual(`${sum(r)}; lines ${r.lines.map(s => s.split('\t')[0]).join(', ')}`);
    expect.soft(r.lines.map(s => s.split(' ')[0]).sort()).toEqual(['I_IMP_911', 'I_IMP_CR', 'I_INT', 'I_TV']);
    expect(r.money('TOTAL')).toBe(round2(Number(m.total)));
  });
});
