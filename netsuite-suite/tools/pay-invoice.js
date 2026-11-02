// Pays an invoice through the Coopeweb API (crm-gateway applyPayment, the call NetSuite uses) with the clock at <date>;
// clock restored. Without <amount> it pays the full amount due.
//   node pay-invoice.js <accountId> <invoiceId> <YYYY-MM-DD> [amount]
// A suspended contract that pays gets a RESUME order automatically (REG-002): complete it like the others.
const { CRM, post, sleep, atDate, gql, orders } = require('./ns-lib');
const [ACC, INV, D, AMOUNT] = process.argv.slice(2);
if (!ACC || !INV || !D) throw new Error('usage: node pay-invoice.js <accountId> <invoiceId> <date> [amount]');
const state = async () => JSON.stringify({
  invoice: (await gql(`{ getInvoiceUnitById(input:{id:"${INV}"}) { status due } }`)).getInvoiceUnitById,
  collection: (await gql(`{ searchCollectionUnits(page:1,size:5,filter:{accountId:"${ACC}"}) { id status nextAction } }`)).searchCollectionUnits,
  subscription: (await gql(`{ getSubscriptionByAccountId(input:{id:"${ACC}"}) { status } }`)).getSubscriptionByAccountId,
  orders: (await orders(ACC)).slice(0, 3),
});
atDate(D, async () => {
  console.log('before', await state());
  const due = (await gql(`{ getInvoiceUnitById(input:{id:"${INV}"}) { due } }`)).getInvoiceUnitById.due;
  const amount = AMOUNT ? Number(AMOUNT) : due;
  const r = await post(`${CRM}/applyPayment`, { paymentDate: '', paymentSource: 'BCR', allocationData: [{ accountId: ACC, invoiceId: INV, currency: 'CRC', amount }] });
  console.log('applyPayment', amount, 'of', due, '→', r.status, r.text.slice(0, 200));
  await sleep(30_000);
  console.log('after', await state());
}).catch(e => { console.error('ERR', e.message); process.exit(1); });
