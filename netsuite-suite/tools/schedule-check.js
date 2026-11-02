// Read-only check of one Daily Schedule on coopegsbx2: node schedule-check.js <YYYY-MM-DD> [lastActivityIdBeforeRun]. Lists job errors, NetSuite sends
// and notifications of the run, and the QA contracts' invoices / credit notes / bill units on that date.
const U = 'https://service-transactional.coopegsbx2.embrix.org/graphql';
const q = async s => (await (await fetch(U, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: s }) })).json());
const D = process.argv[2] || '2027-10-01';
const MIN_ACT = Number(process.argv[3] || 0); // only activities after this id (A-<n>), e.g. the last id before the run
const QA = ['QA-ANH-NS-002', 'QA-ANH-NS-003', 'QA-ANH-NS-004', 'QA-ANH-NS-005', 'QA-ANH-NS-R2-10121013-P1', 'QA-ANH-NS-R2-10121013-N1', 'QA-ANH-NS-R2-10121024-P1', 'QA-ANH-NS-R2-10121024-N1', 'QA-ANH-NS-R2-10121024-I1', 'QA-ANH-NS-R2-10121024-X1', 'QA-ANH-NS-R2-10121024-X2', 'QA-ANH-NS-R2-10121024-X3', 'QA-ANH-NS-R2-10121024-N2', 'QA-ANH-NS-R2-10121024-E1', 'QA-ANH-NS-R2-10160312-P1', 'QA-ANH-NS-R2-10160658-P1'];
(async () => {
  const s = (await q(`{ getJobScheduleByDate(input:{scheduleDate:"${D}"}) { id userId jobScheduleList { type status } } }`)).data.getJobScheduleByDate;
  console.log('schedule', s.id, s.userId, s.jobScheduleList.map(j => j.type + '=' + j.status).join(' '));
  for (const j of s.jobScheduleList) {
    const e = (await q(`{ getJobErrors(input:{id:"${s.id}", scheduleName:"${s.id}", scheduleDate:"${D}", type:${j.type}, scheduleFrequency:DAILY}) { countError jobErrorGroupList { reason count } } }`)).data?.getJobErrors;
    if (e?.countError) console.log(' ', j.type, 'errors', e.countError, JSON.stringify(e.jobErrorGroupList));
  }
  const acts = [];
  for (let p = 1; p < 6; p++) { const l = (await q(`{ searchActivities(page:${p},size:200,filter:{apiName:"CREATE_INVOICE"}) { id accountId entityId activityDate response } }`)).data.searchActivities; acts.push(...l); if (l.length < 200) break; }
  const today = acts.filter(a => a.activityDate === D && Number(a.id.slice(2)) > MIN_ACT);
  const ok = today.filter(a => /"error": false/.test(a.response));
  const why = {}; for (const a of today.filter(a => !/"error": false/.test(a.response))) { const m = (String(a.response).match(/"message": "([^"]{0,70})/) || [, String(a.response).slice(0, 60)])[1]; why[m] = (why[m] || 0) + 1; }
  console.log(`CREATE_INVOICE on ${D} from this run: ${today.length} sent, ${ok.length} accepted; rejections:`, JSON.stringify(why));
  const notif = [];
  for (const api of ['SEND_SMS_NOTIFICATION', 'SEND_EMAIL_NOTIFICATION', 'SEND_EMAIL']) { const l = (await q(`{ searchActivities(page:1,size:200,filter:{apiName:"${api}"}) { id accountId activityDate } }`)).data?.searchActivities ?? []; notif.push(...l.filter(a => a.activityDate === D && Number(a.id.slice(2)) > MIN_ACT).map(a => api + ':' + a.accountId)); }
  console.log('notification activities from this run:', notif.length, notif.slice(0, 20).join(' '));
  console.log('\n== QA accounts');
  for (const acc of QA) {
    const d = (await q(`{ i: searchInvoiceUnits(page:1,size:50,filter:{accountId:"${acc}"}) { id invoiceDate type total due status folioStatus financeRefId financeVersion } a: searchActivities(page:1,size:200,filter:{accountId:"${acc}"}) { id apiName entityId activityDate request response } n: searchNotesUnits(page:1,size:20,filter:{accountId:"${acc}",startDate:"${D}",endDate:"${D}"}) { id invoiceId total financeSyncStatus financeErrorMessage } b: searchBillUnits(page:1,size:3,filter:{accountId:"${acc}"}) { status startDate endDate total } }`)).data;
    const inv = (d.i ?? []).filter(i => i.invoiceDate === D);
    const newActs = (d.a ?? []).filter(a => Number(a.id.slice(2)) > MIN_ACT && a.activityDate === D);
    const line = [`${acc}: invoices ${D}: ${inv.map(i => `${i.id} ${i.type} ${i.total} ${i.folioStatus} ref ${i.financeVersion ?? '-'}`).join(', ') || 'none'}`];
    for (const a of newActs.filter(a => a.apiName === 'CREATE_INVOICE')) { const r = JSON.parse(a.request).invoice; line.push(`  CREATE_INVOICE ${a.entityId}: entity ${JSON.stringify(r.entity)} tipoFactura ${JSON.stringify(r.tipoFactura)} memo "${r.memo}" tranDate ${r.tranDate} due ${r.fechaVencimiento} items ${r.items.map(i => `${i.item}:tc${i.taxCode}`).join(' ')} → ${String(a.response).slice(0, 110)}`); }
    for (const a of newActs.filter(a => a.apiName === 'CREATE_CREDIT_NOTES')) { const m = JSON.parse(a.request).creditMemo; line.push(`  CREATE_CREDIT_NOTES ${a.entityId}: items ${m.items.map(i => `${i.item}:tc${i.taxCode} tax ${i.taxAmount}`).join(' ')} applys ${JSON.stringify(m.applys)} reason ${m.motivoAnulacion} → ${String(a.response).slice(0, 110)}`); }
    if ((d.n ?? []).length) line.push(`  notes: ${JSON.stringify(d.n)}`);
    line.push(`  other new activities: ${newActs.filter(a => !/CREATE_INVOICE|CREATE_CREDIT_NOTES/.test(a.apiName)).map(a => a.apiName).join(' ') || '-'}; bill units ${JSON.stringify((d.b ?? []).slice(0, 2))}`);
    console.log(line.join('\n'));
  }
})();
