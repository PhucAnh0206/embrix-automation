// Manual invoice (Internet 10,000, as Bills > Manual billing) on a contract with the clock at <date>, then optionally a line credit
// with tax on its Internet line; prints the automatic credit notes and every NetSuite call. Clock restored.
//   node invoice-and-credit.js <accountId> <YYYY-MM-DD>                     CRN-003 / RET-002: intercompany contract → automatic credit
//   node invoice-and-credit.js <accountId> <YYYY-MM-DD> --line-credit 1000  CRN-011: exempt contract → credit keeps the line tax code
//   node invoice-and-credit.js 146195 <YYYY-MM-DD> --item ELECTRICITY:I-100003 INV-004: prepaid electricity line (Coope rule 28 Oct: sent)
// Contracts NetSuite knows (2026-10-24): 798169 intercompany (Coope), 244822 exempt 38.46% → tax code 8 (Coope), 208886 (team).
// The date must be after the contract's latest credit note and not in September 2027 (Invoicing report).
const { gql, sleep, atDate, db, invoices, notes, activities, nsCall, waitFor } = require('./ns-lib');
const [ACC, D, flag, amt] = process.argv.slice(2);
// --item <serviceType>:<itemId> bills that item instead of Internet (no line credit then)
const [SVC, ITEM] = flag === '--item' && amt ? amt.split(':') : ['INTERNET', 'I_INT'];
if (!ACC || !D) throw new Error('usage: node invoice-and-credit.js <accountId> <date> [--line-credit <amount>]');
atDate(D, async () => {
  const before = new Set((await invoices(ACC)).map(i => i.id)), nb = new Set((await notes(ACC)).map(n => n.id));
  const rec = [{ accountId: ACC, serviceType: SVC, itemId: ITEM, description: 'QA-NS invoice-and-credit', startDate: D, endDate: D, quantity: 1, unitPrice: 10000, netAmount: 10000, grossAmount: 10000, discountAmount: 0 }];
  try {
    await gql('mutation($i:ManualPreratedTxnInput!){ manualInvoiceService(input:$i) { id } }',
      { i: { accountId: ACC, txnDate: D, billStartDate: D, billEndDate: D, scheduleDaily: false, returnBase64PDF: false, manualPreratedTxnRec: rec } });
  } catch (e) { console.log('manualInvoiceService:', e.message, '(waiting for the invoice anyway; never retry: duplicates)'); }
  const inv = await waitFor(async () => (await invoices(ACC)).find(x => !before.has(x.id)));
  console.log('invoice', JSON.stringify(inv));
  if (!inv) return;
  await sleep(40_000);
  if (flag === '--line-credit') {
    const c = await db();
    const line = (await c.query("select index, name from core_engine.invoice_summary where id=$1 and itemid='I_INT' order by index limit 1", [inv.id])).rows[0];
    await c.end();
    const r = await gql(`mutation{ processAdjustment(input:{accountId:"${ACC}",userId:"congeroadmin",source:AGENT_CARE,generateCreditNoteNow:true,invoiceId:"${inv.id}",
      type:INVOICE_LINE_ADJUSTMENT,arType:CREDIT,taxRule:WITH_TAX,reason:DATA_ERROR,notes:"QA-NS line credit",invoiceLines:[{index:${line.index},name:${JSON.stringify(line.name)},amount:${Number(amt) || 1000}}]}) { id invoiceId } }`);
    console.log('processAdjustment', JSON.stringify(r.processAdjustment));
  }
  await sleep(90_000);
  const nn = (await notes(ACC)).filter(n => !nb.has(n.id));
  console.log('new credit notes', JSON.stringify(nn));
  const ids = new Set([inv.id, ...nn.map(n => n.id)]);
  for (const a of (await activities(ACC)).filter(a => ids.has(a.entityId) && /CREATE_INVOICE|CREATE_CREDIT_NOTES/.test(a.apiName))) console.log(nsCall(a));
}).catch(e => { console.error('ERR', e.message); process.exit(1); });
