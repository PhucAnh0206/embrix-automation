/**
 * NetSuite edge cases not in the client document (exploration, 10-26). Results go to test-cases\netsuite\eft-106
 * (results.json + evidence\EDGE-*), to be folded into internal-checks.csv / bugs.md once read.
 *   EDGE-RESEND   can an invoice already in NetSuite be sent again? screen (Bills > Action) and server (syncInvoice)
 *   EDGE-CREDIT   credits on 208886 beyond the open amount, beyond the total, on a paid invoice, two on one invoice
 *                 (Apply Adjustment screen; clock window 2027-11-04, restored to NS_BASELINE)
 *   EDGE-ERRORS   invoices NetSuite refused: what the agent sees on Bills and whether they can be sent again
 * Uses the invoices of the payments exploration (0279768..0279772, 208886): NS_EDGE_* override them.
 *   $env:EMBRIX_ENV_FILE='.env.coopegsbx2'; $env:NS_ALLOW_CLOCK='true'; npx playwright test --project=dev tests/coopeg/netsuite-actions/ns-edge-cases.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import { NsApi, parse } from '../../../helpers/netsuite/ns-api.helper';
import { attachUi, NsUi } from '../../../helpers/netsuite/ns-ui.helper';
import { NsSandbox } from '../../../helpers/netsuite/ns-sandbox.helper';
import { TD } from '../../../helpers/netsuite/ns-data';
import { db, record, Shots } from '../tickets/eft-106/eft-lib';

const ACC = TD.DEFAULT.account;
const E = process.env;
const SYNCED = E.NS_EDGE_SYNCED ?? '0279768';     // in NetSuite (FA586064)
const PARTLY_PAID = E.NS_EDGE_OPEN ?? '0279769';  // 1,147.50, 573.50 due
const PAID = E.NS_EDGE_PAID ?? '0279770';         // closed by payment
const CREDIT_DAY = E.NS_EDGE_CREDIT_DAY ?? '2027-11-04';
const HOME = process.env.NS_BASELINE ?? '2027-01-01';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test.use({ viewport: { width: 1800, height: 1000 } });

test.describe.serial('NetSuite edge cases', () => {
  let api: NsApi; let ui: NsUi | undefined;
  test.beforeAll(async ({ playwright, browser }) => {
    api = new NsApi(await playwright.request.newContext());
    ui = await attachUi(api, browser);
  });

  test('EDGE-RESEND: an invoice already in NetSuite is not sent a second time', async ({ browser, page }) => {
    test.setTimeout(20 * 60_000);
    const before = await api.invoice(SYNCED);
    const sendsBefore = (await api.activitiesFor(ACC, SYNCED, 'CREATE_INVOICE')).length;
    // Screen: what the agent is offered on the invoice's row.
    const actions = await ui!.billActions(ACC, SYNCED);
    // Server: the same request the screen sends for SYNC_INVOICE, on an invoice the screen would not offer it for.
    api.ui = undefined;
    let server: string;
    try { server = JSON.stringify(await api.syncInvoice(SYNCED)); } catch (e) { server = `refused: ${(e as Error).message.slice(0, 200)}`; }
    api.ui = ui;
    await sleep(60_000);
    const sends = await api.activitiesFor(ACC, SYNCED, 'CREATE_INVOICE');
    const fresh = sends.slice(sendsBefore);
    const tranIds = fresh.map(a => parse(a.response)?.data?.tranId).filter(Boolean) as string[];
    const after = await api.invoice(SYNCED);
    const shots = new Shots(page, 'EDGE-RESEND');
    await shots.billRow('bills', ACC, SYNCED);
    const sb = await NsSandbox.open(browser);
    const found: Record<string, number> = {};
    try { for (const n of [before.financeVersion, ...tranIds]) found[n] = (await shots.netsuite(`netsuite-${n}`, sb, n)).total; } finally { await sb.close(); }
    const duplicate = tranIds.some(t => t !== before.financeVersion);
    record('EDGE-RESEND', duplicate ? 'Fail' : 'Pass',
      `Invoice ${SYNCED} (${before.financeVersion}): Bills actions offered ${actions.join(', ') || 'none'}${actions.includes('SYNC_INVOICE') ? ' (SYNC_INVOICE offered!)' : ' (no SYNC_INVOICE)'}; server syncInvoice → ${server.slice(0, 160)}; new CREATE_INVOICE calls ${fresh.length}${fresh.length ? ` (${fresh.map(a => `${a.id}: ${String(a.response).slice(0, 100)}`).join(' | ')})` : ''}; after: ${after.financeSyncStatus} ${after.financeVersion}; NetSuite sandbox ${Object.entries(found).map(([k, v]) => `${k} ×${v}`).join(', ')}.`,
      { before, after, actions, server, fresh, found, screenshots: shots.files });
    expect(actions, 'screen offers no resend').not.toContain('SYNC_INVOICE');
    expect(duplicate, 'second NetSuite invoice').toBe(false);
  });

  test('EDGE-CREDIT: credits beyond the open amount, beyond the total, on a paid invoice, and two on one invoice', async ({ page }) => {
    test.setTimeout(40 * 60_000);
    const start = (await api.ccpDate()).slice(0, 10);
    expect(start, `clock at ${HOME} before the window`).toBe(HOME);
    const notesBefore = new Set((await api.creditNotesOf(ACC)).map(n => n.id));
    const tries: { label: string; invoice: string; amount: number }[] = [
      { label: 'more than the open amount (573.50 due)', invoice: PARTLY_PAID, amount: 800 },
      { label: 'more than the invoice total (1,147.50)', invoice: PARTLY_PAID, amount: 2000 },
      { label: 'on an invoice closed by payment', invoice: PAID, amount: 100 },
      { label: 'second small credit on the same invoice (1)', invoice: SYNCED, amount: 50 },
      { label: 'second small credit on the same invoice (2)', invoice: SYNCED, amount: 60 },
    ];
    const out: any[] = [];
    try {
      await api.setCcpDate(CREDIT_DAY);
      for (const t of tries) {
        const known = new Set((await api.creditNotesOf(ACC)).map(n => n.id));
        let toast: string;
        try { toast = (await ui!.applyAdjustment({ accountId: ACC, invoiceId: t.invoice, amount: t.amount, reason: 'DATA_ERROR', notes: `QA-NS-EDGE ${t.label}` })).toast; }
        catch (e) { toast = `screen: ${(e as Error).message.split('\n')[0].slice(0, 160)}`; }
        let note: any;
        for (let i = 0; i < 9 && !note; i++) { await sleep(10_000); note = (await api.creditNotesOf(ACC)).find(n => !known.has(n.id)); }
        let ns = '';
        if (note) {
          const act = await api.waitForActivity(ACC, note.id, 'CREATE_CREDIT_NOTES', 120_000);
          const res = parse(act?.response);
          ns = res ? (res.error === false ? `NetSuite ${res.data?.tranId}` : `NetSuite refused: ${JSON.stringify(res).slice(0, 160)}`) : 'no NetSuite answer yet';
        }
        const inv = await api.invoice(t.invoice);
        out.push({ ...t, toast, note: note ? `${note.id} ${note.total}` : 'none', ns, invoiceAfter: `${inv.status} due ${inv.due}` });
        console.log(`  ${t.label}: ${toast} | note ${note?.id ?? 'none'} ${ns} | invoice ${inv.status} due ${inv.due}`);
      }
    } finally {
      await api.setCcpDate(HOME);
    }
    expect((await api.ccpDate()).slice(0, 10), 'clock restored').toBe(HOME);
    const shots = new Shots(page, 'EDGE-CREDIT');
    for (const id of [...new Set(tries.map(t => t.invoice))]) await shots.billRow(`${id}-bills`, ACC, id);
    const created = (await api.creditNotesOf(ACC)).filter(n => !notesBefore.has(n.id));
    for (const n of created) await shots.creditNoteRow(`${n.id}-credit-notes`, ACC, n.id);
    record('EDGE-CREDIT', 'Recorded', out.map(o => `${o.label} (${o.invoice}, ${o.amount}): ${o.toast}; credit note ${o.note}${o.ns ? `, ${o.ns}` : ''}; invoice ${o.invoiceAfter}`).join(' | '),
      { tries: out, created, screenshots: shots.files });
  });

  test('EDGE-ERRORS: invoices NetSuite refused show the reason on Bills and can be sent again', async ({ page }) => {
    test.setTimeout(20 * 60_000);
    // Refusals other than "contract not found" (test contracts) since this environment was set up.
    const rows = await db(`select distinct on (i.financeerrormessage) i.id, i.accountid, i.financeerrormessage e
      from core_engine.invoice_unit i where i.financesyncstatus = 'ERROR' and i.financeerrormessage not like '%No se ha encontrado un contrato%'
      and i.id like '0279%' order by i.financeerrormessage, i.id desc`);
    const shots = new Shots(page, 'EDGE-ERRORS');
    const lines: string[] = [];
    for (const r of rows.slice(0, 6)) {
      const actions = await ui!.billActions(r.accountid, r.id).catch(e => [`(${(e as Error).message.slice(0, 60)})`]);
      await shots.billRow(`${r.id}-bills`, r.accountid, r.id).catch(() => { });
      lines.push(`${r.id} (${r.accountid}): "${String(r.e).slice(0, 90)}" — actions ${actions.join(', ') || 'none'}`);
    }
    record('EDGE-ERRORS', 'Recorded', lines.join(' | ') || 'no refused invoice besides "contract not found"', { rows, screenshots: shots.files });
  });
});
