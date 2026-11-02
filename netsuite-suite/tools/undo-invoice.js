// INV-018: Undo of an invoice that is already in NetSuite (or stamped) with the clock at <date>; clock restored.
// Expected on feature/netsuite: the invoice is kept and CLOSED by a full credit note with tax (reason = ccp undoInvoiceCreditReason,
// "NC - Anulación por refacturación" on coopegsbx2), stamped and sent to NetSuite applied to the invoice.
//   node undo-invoice.js <accountId> <invoiceId> <YYYY-MM-DD>           e.g. 208886 0279597 2027-11-02 (after its latest credit)
// To get a fresh invoice first: node invoice-and-credit.js 208886 <date>
const { gql, sleep, atDate, notes, activities, nsCall } = require('./ns-lib');
const [ACC, INV, D] = process.argv.slice(2);
if (!ACC || !INV || !D) throw new Error('usage: node undo-invoice.js <accountId> <invoiceId> <date>');
const inv = async () => (await gql(`{ getInvoiceUnitById(input:{id:"${INV}"}) { id status due total billUnitId } }`)).getInvoiceUnitById;
atDate(D, async () => {
  const b = await inv(); console.log('before', JSON.stringify(b));
  const nb = new Set((await notes(ACC)).map(n => n.id));
  try { console.log('undoInvoice', JSON.stringify((await gql('mutation($i:UndoInvoiceInput!){ undoInvoice(input:$i) { id } }', { i: { billUnitid: b.billUnitId } })).undoInvoice)); }
  catch (e) { console.log('undoInvoice refused:', e.message); }
  await sleep(90_000);
  console.log('after', JSON.stringify(await inv()));
  const nn = (await notes(ACC)).filter(n => !nb.has(n.id));
  console.log('new credit notes', JSON.stringify(nn));
  for (const a of (await activities(ACC)).filter(a => nn.some(n => n.id === a.entityId) && /CREDIT/.test(a.apiName))) console.log(nsCall(a));
}).catch(e => { console.error('ERR', e.message); process.exit(1); });
