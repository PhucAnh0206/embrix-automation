// Read-only, for ns-cycle.ps1:
//   node order-check.js open <accountId>                 prints "<orderId> <type> <status> <effectiveDate>" of the newest unfinished order, or nothing
//   node order-check.js sub <accountId> <STATUS> [sec]   waits until the subscription has STATUS (default 120 s); exit 1 if not
//   node order-check.js schedule <YYYY-MM-DD>            prints the Daily Schedule status of the date, or none
//   node order-check.js invoice <accountId> <dueDate>    prints the id of the contract's invoice due on that date
const { gql, orders, invoices, sleep } = require('./ns-lib');
const [cmd, ACC, WANT, SEC = '120'] = process.argv.slice(2);
(async () => {
  if (cmd === 'open') {
    const o = (await orders(ACC)).find(x => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(x.status));
    if (o) console.log(`${o.id} ${o.type} ${o.status} ${o.effectiveDate}`);
    return;
  }
  if (cmd === 'sub') {
    let s = '';
    for (let t = 0; t <= Number(SEC); t += 10) {
      s = (await gql(`{ getSubscriptionByAccountId(input:{id:"${ACC}"}) { status } }`)).getSubscriptionByAccountId?.[0]?.status ?? '';
      if (s === WANT) break;
      await sleep(10_000);
    }
    console.log(`${ACC} subscription ${s || 'none'} (expected ${WANT})`);
    if (s !== WANT) process.exitCode = 1;
    return;
  }
  if (cmd === 'schedule') { console.log((await gql(`{ getJobScheduleByDate(input:{scheduleDate:"${ACC}"}) { status } }`)).getJobScheduleByDate?.status ?? 'none'); return; }
  if (cmd === 'invoice') { const i = (await invoices(ACC)).find(x => String(x.dueDate).slice(0, 10) === WANT); if (i) console.log(i.id); return; }
  throw new Error('usage: node order-check.js open <accountId> | sub <accountId> <STATUS> [seconds]');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
