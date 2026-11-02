// CHG-001: plan change through the Coopeweb API (processAccountAndOrder MODIFY: add IPTV Standard + TV, as Kiet's TS02 / TC-09)
// with the clock at <date>; clock restored. QA contracts only. The MODIFY order then waits for provisioning: complete it like the others.
//   node plan-change.js <accountId> <YYYY-MM-DD> [suffix]          suffix makes the order id unique when run twice (default A)
const { CRM, post, sleep, atDate, orders, qaOnly } = require('./ns-lib');
const [ACC, D, SUF = 'A'] = process.argv.slice(2);
qaOnly(ACC);
if (!D) throw new Error('usage: node plan-change.js <accountId> <date> [suffix]');
atDate(D, async () => {
  const body = { userId: 'COOPEWEB', accountId: ACC, orderType: 'MODIFY', billOrderCharges: 'false', staticIpRented: 'false', orderId: `MODI-${ACC}-${SUF}`,
    services: [
      { bundleId: 'BDL_TV_ADIC', packageId: '', serviceType: 'IPTV', action: 'ADD', quantity: '1' },
      { bundleId: 'BDL_IPTV', packageId: 'PKG_IPTV_STANDARD', serviceType: 'INTERNET', action: 'ADD', quantity: '1' },
      { bundleId: 'BDL_TV_IND', packageId: 'PKG_IPTV_STANDARD', serviceType: 'IPTV', action: 'ADD', quantity: '1' }] };
  const r = await post(`${CRM}/processAccountAndOrder`, body);
  console.log('MODIFY →', r.status, r.text.slice(0, 250));
  await sleep(45_000);
  console.log('orders', JSON.stringify(await orders(ACC)));
}).catch(e => { console.error('ERR', e.message); process.exit(1); });
