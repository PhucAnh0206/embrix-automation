// Read-only: collection units + subscription status of the QA contracts in collection (node collection-state.js).
const U = 'https://service-transactional.coopegsbx2.embrix.org/graphql';
const q = async s => (await (await fetch(U, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: s }) })).json());
const ACC = ['QA-ANH-NS-R2-10121024-P1', 'QA-ANH-NS-R2-10121024-X1', 'QA-ANH-NS-R2-10121024-N2', 'QA-ANH-NS-R2-10121024-E1'];
(async () => {
  console.log('clock', (await q('{ getCcpDateTime(dummy:"x") { ccpTime } }')).data.getCcpDateTime.ccpTime);
  for (const acc of ACC) {
    const d = (await q(`{ u: searchCollectionUnits(page:1,size:100,filter:{accountId:"${acc}"}) { id invoiceId status nextActionDate nextAction } s: getSubscriptionByAccountId(input:{id:"${acc}"}) { id status } a: getAccountById(input:{id:"${acc}"}) { status } h: searchCollectionHistory(page:1,size:20,filter:{accountId:"${acc}"}) { id } }`)).data;
    const open = (d.u ?? []).filter(x => x.status !== 'CLOSED');
    const act = {}; for (const x of open) { const k = `${x.status}/${x.nextAction}/${String(x.nextActionDate).slice(0, 10)}`; act[k] = (act[k] || 0) + 1; }
    console.log(acc, 'account', d.a?.status, 'subs', JSON.stringify(d.s), 'units', JSON.stringify(act), 'example', open[0]?.id, open[0]?.invoiceId);
  }
})();
