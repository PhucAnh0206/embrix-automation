// DB WRITE. Releases a device (ONT serial / provisioning id) held by ONE failed order of a QA contract, so a new order
// can use it. Needed because a PROVISIONING_ERROR order keeps its device and the screens offer no way out (10-26:
// Cancel is disabled, Submit order only re-checks the status in NOKIA, a new order is refused "duplicate key").
// The order's row is renamed <device>-RELEASED-<MMDD> (kept, not deleted); a backup goes to evidence\schedule-backups.
//   node release-device.js <orderId> <provisioningId>
// Refuses: orders of non-QA accounts, orders not failed (PROVISIONING_ERROR) or stuck (PROVISIONING_INITIATED, e.g. the 25 Oct
// run stopped before NOKIA configured anything), anything but exactly one matching row.
const fs = require('fs');
const path = require('path');
const { db } = require('./ns-lib');
const [ORD, DEV] = process.argv.slice(2);
if (!ORD || !DEV) throw new Error('usage: node release-device.js <orderId> <provisioningId>');
(async () => {
  const c = await db();
  try {
    await c.query('BEGIN');
    const o = (await c.query('select id, accountid, status from core_oms."order" where id=$1', [ORD])).rows[0];
    if (!o || !/^QA-ANH-NS-/.test(o.accountid)) { await c.query('ROLLBACK'); return console.log('refused: not an order of a QA contract', JSON.stringify(o)); }
    if (!['PROVISIONING_ERROR', 'PROVISIONING_INITIATED'].includes(o.status)) { await c.query('ROLLBACK'); return console.log('refused: order is', o.status); }
    const rows = (await c.query('select * from core_oms.order_service_provisions where id=$1 and provisioningid=$2', [ORD, DEV])).rows;
    if (rows.length !== 1) { await c.query('ROLLBACK'); return console.log('refused: matching rows', rows.length); }
    const dir = path.join(__dirname, '..', 'evidence', 'schedule-backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `release-device-${ORD}-${DEV}.json`), JSON.stringify(rows[0], null, 2));
    const tag = `${DEV}-RELEASED-${new Date().toISOString().slice(5, 10).replace('-', '')}`;
    const u = await c.query('UPDATE core_oms.order_service_provisions SET provisioningid=$3 WHERE id=$1 and provisioningid=$2', [ORD, DEV, tag]);
    if (u.rowCount !== 1) { await c.query('ROLLBACK'); return console.log('ROLLBACK', u.rowCount); }
    await c.query('COMMIT');
    console.log(`COMMIT ${ORD} (${o.accountid}): ${DEV} released (row renamed ${tag}); backup saved`);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.log('ERR', e.message); process.exitCode = 1; } finally { await c.end(); }
})();
