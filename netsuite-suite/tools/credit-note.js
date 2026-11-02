// Credit-note checks the dev asks for by name (ADJ-002, CRN-006). Prints the exact local and UTC time of each action
// (the stamping gateway keeps its log only a few hours), the credit notes it made and every NetSuite call for them.
//   node credit-note.js resend <accountId> <CR-id>
//       re-send a credit note to NetSuite (as Credit Notes > Resend: syncCreditNotes)
//   node credit-note.js line <accountId> <invoiceId> <itemId> <amount> <WITH_TAX|WITHOUT_TAX> "<customReason>" <YYYY-MM-DD>
//       line credit on the invoice's first <itemId> line, clock at <date> (restored). customReason as configured, e.g.
//       "NC - Error en facturación" (stamped) or "Corrección" (not stamped). The date must be after the account's latest credit note.
//   node credit-note.js show <accountId> <CR-id>...
const { gql, sleep, atDate, db, notes, activities, nsCall } = require('./ns-lib');
const [CMD, ACC, ...rest] = process.argv.slice(2);
const stamp = () => `${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })} VN / ${new Date().toISOString()} UTC`;

async function show(ids) {
  const all = await notes(ACC);
  for (const id of ids) console.log('note', JSON.stringify(all.find(n => n.id === id) ?? { id, found: false }));
  for (const a of (await activities(ACC)).filter(a => ids.includes(a.entityId) && /CREDIT/.test(a.apiName))) console.log(nsCall(a));
}

async function main() {
  if (CMD === 'show') return show(rest);
  if (CMD === 'resend') {
    const [CN] = rest;
    console.log('resend', CN, 'at', stamp());
    try { console.log(JSON.stringify((await gql(`mutation{ syncCreditNotes(input:{id:${JSON.stringify(CN)}}) { id docType financeSyncStatus isError message } }`)).syncCreditNotes)); }
    catch (e) { console.log('syncCreditNotes refused:', e.message); }
    await sleep(20_000);
    return show([CN]);
  }
  if (CMD === 'line') {
    const [INV, ITEM, AMT, RULE, WHY, D] = rest;
    if (!D) throw new Error('usage: see the header of credit-note.js');
    return atDate(D, async () => {
      const c = await db();
      const line = (await c.query('select index, name from core_engine.invoice_summary where id=$1 and itemid=$2 order by index limit 1', [INV, ITEM])).rows[0];
      await c.end();
      if (!line) throw new Error(`no ${ITEM} line on ${INV}`);
      const nb = new Set((await notes(ACC)).map(n => n.id));
      console.log(`processAdjustment ${INV} ${ITEM} line ${line.index} ${AMT} ${RULE} "${WHY}" at ${stamp()}`);
      try {
        const r = await gql('mutation($i:AdjustmentInput!){ processAdjustment(input:$i) { id invoiceId } }', { i: { accountId: ACC, userId: 'congeroadmin', source: 'AGENT_CARE',
          generateCreditNoteNow: true, invoiceId: INV, type: 'INVOICE_LINE_ADJUSTMENT', arType: 'CREDIT', taxRule: RULE, customReason: WHY, notes: `QA-NS credit-note ${RULE}`,
          invoiceLines: [{ index: line.index, name: line.name, amount: Number(AMT) }] } });
        console.log('processAdjustment', JSON.stringify(r.processAdjustment));
      } catch (e) { console.log('processAdjustment refused at', stamp(), ':', e.message); }
      await sleep(60_000);
      const nn = (await notes(ACC)).filter(n => !nb.has(n.id));
      console.log('checked at', stamp());
      return show(nn.map(n => n.id));
    });
  }
  throw new Error('usage: node credit-note.js resend|line|show … (see the header)');
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
