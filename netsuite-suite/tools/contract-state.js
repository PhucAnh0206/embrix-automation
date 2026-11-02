// Read-only: everything about one contract on coopegsbx2.  node contract-state.js <accountId> [--calls]
// Subscription, services, orders, bill units, invoices, collection, credit notes; --calls adds every NetSuite / Hacienda call.
const { gql, invoices, notes, orders, activities, nsCall } = require('./ns-lib');
const [ACC, flag] = process.argv.slice(2);
if (!ACC) throw new Error('usage: node contract-state.js <accountId> [--calls]');
(async () => {
  const d = await gql(`{ s: getSubscriptionByAccountId(input:{id:"${ACC}"}) { id status }
    v: getServiceUnitsByAccountId(input:{id:"${ACC}"}) { id status }
    b: searchBillUnits(page:1,size:20,filter:{accountId:"${ACC}"}) { id status startDate endDate total billTotal }
    u: searchCollectionUnits(page:1,size:10,filter:{accountId:"${ACC}"}) { id invoiceId status nextAction nextActionDate unitActionList { action date } } }`);
  console.log('subscription', JSON.stringify(d.s), 'services', JSON.stringify(d.v));
  console.log('orders', JSON.stringify(await orders(ACC)));
  console.log('bills'); for (const b of d.b ?? []) console.log(' ', JSON.stringify(b));
  console.log('invoices'); for (const i of await invoices(ACC)) console.log(' ', JSON.stringify(i));
  console.log('collection'); for (const u of d.u ?? []) console.log(' ', JSON.stringify(u));
  console.log('credit notes'); for (const n of await notes(ACC)) console.log(' ', JSON.stringify(n));
  if (flag === '--calls') {
    console.log('calls (newest first)');
    for (const a of (await activities(ACC)).filter(a => /INVOICE|CREDIT/.test(a.apiName || ''))) console.log(' ', nsCall(a));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
