// DB WRITE. Completes the provisioning steps of ONE order of a QA contract, as Kiet's CoopeG automation does (TC02 / TC07-A / TC08):
// order_prov_sequence_list + order_provisioning_inputs → COMPLETED, order → PROVISIONING_ERROR, so "Submit order" can finish it.
// Used for NEW, SUSPEND, RESUME, MODIFY and CANCEL orders (NOKIA / Coopeweb do not answer for test contracts on coopegsbx2).
//   node complete-order.js <orderId>            then Submit order (ns-submit-order.spec.ts) with the clock at the order's effective date
// Refuses: orders of non-QA accounts, orders already COMPLETED / CANCELLED / FAILED (a second run turned ORD-2879 FAILED).
const { db } = require('./ns-lib');
const ORD = process.argv[2];
if (!ORD) throw new Error('usage: node complete-order.js <orderId>');
(async () => {
  const c = await db();
  try {
    await c.query('BEGIN');
    const o = (await c.query('select id, accountid, type, status from core_oms."order" where id=$1', [ORD])).rows[0];
    if (!o || !/^QA-ANH-NS-/.test(o.accountid)) { await c.query('ROLLBACK'); return console.log('refused: not an order of a QA contract', JSON.stringify(o)); }
    if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(o.status)) { await c.query('ROLLBACK'); return console.log('refused: order already', o.status); }
    const n = (await c.query('select count(*)::int n from core_oms.order_prov_sequence_list where id=$1', [ORD])).rows[0].n;
    const s = await c.query(`UPDATE core_oms.order_prov_sequence_list SET status='COMPLETED' WHERE id=$1`, [ORD]);
    const i = await c.query(`UPDATE core_oms.order_provisioning_inputs SET status='COMPLETED' WHERE id=$1`, [ORD]);
    const a = await c.query(`UPDATE core_oms."order" SET status='PROVISIONING_ERROR' WHERE id=$1`, [ORD]);
    if (s.rowCount !== n || n === 0 || n > 30 || i.rowCount > 5 || a.rowCount !== 1) { await c.query('ROLLBACK'); return console.log('ROLLBACK', s.rowCount, n, i.rowCount, a.rowCount); }
    await c.query('COMMIT');
    console.log(`COMMIT ${ORD} (${o.type}, ${o.accountid}, was ${o.status}): ${n} steps, ${i.rowCount} inbound COMPLETED, order PROVISIONING_ERROR`);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.log('ERR', e.message); process.exitCode = 1; } finally { await c.end(); }
})();
