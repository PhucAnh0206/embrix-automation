// DB WRITE (shared data, Anh's OK given 10-24). Deletes the Daily Schedules dated FROM..TO, as every billing spec of Kiet's CoopeG
// automation does before billing (old schedules make billing refuse "future cycle open" or skip the date). Rows are saved first.
//   node clean-schedules.js <from YYYY-MM-DD> <to YYYY-MM-DD>          dry run: lists what would go
//   node clean-schedules.js <from> <to> --go                          deletes; backup in ../evidence/schedule-backups/
// Keep the range to the dates the run bills (at most 62 days). Restore = re-insert the backup rows (job_schedule, then job_schedule_list).
const fs = require('fs');
const path = require('path');
const { db } = require('./ns-lib');
const [FROM, TO, GO] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM || '') || !/^\d{4}-\d{2}-\d{2}$/.test(TO || '')) throw new Error('usage: node clean-schedules.js <from> <to> [--go]');
if ((new Date(TO) - new Date(FROM)) / 864e5 > 62 || TO < FROM) throw new Error('range must be 0..62 days');
(async () => {
  const c = await db();
  try {
    await c.query("SET TIME ZONE 'Asia/Ho_Chi_Minh'"); // schedule dates are stored as local midnight (+07)
    const js = (await c.query('select * from core_engine.job_schedule where scheduledate::date between $1::date and $2::date order by scheduledate', [FROM, TO])).rows;
    const ids = js.map(j => j.id);
    const jl = ids.length ? (await c.query('select * from core_engine.job_schedule_list where id = any($1)', [ids])).rows : [];
    for (const j of js) console.log(`${j.id} ${new Date(j.scheduledate).toLocaleDateString('sv-SE')} ${j.status}`);
    console.log(`${js.length} schedules, ${jl.length} job rows`);
    if (GO !== '--go' || !ids.length) return console.log(GO === '--go' ? 'nothing to delete' : 'dry run (add --go to delete)');
    const dir = path.join(__dirname, '..', 'evidence', 'schedule-backups');
    fs.mkdirSync(dir, { recursive: true });
    const bk = path.join(dir, `jobs-${FROM}_${TO}-${Date.now()}.json`);
    fs.writeFileSync(bk, JSON.stringify({ job_schedule: js, job_schedule_list: jl }, null, 1));
    await c.query('BEGIN');
    const a = await c.query('DELETE FROM core_engine.job_schedule_list WHERE id = any($1)', [ids]);
    const b = await c.query('DELETE FROM core_engine.job_schedule WHERE id = any($1)', [ids]);
    if (b.rowCount !== ids.length || a.rowCount !== jl.length) { await c.query('ROLLBACK'); return console.log('ROLLBACK', a.rowCount, b.rowCount); }
    await c.query('COMMIT');
    console.log(`COMMIT deleted ${b.rowCount} schedules, ${a.rowCount} job rows; backup ${bk}`);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.log('ERR', e.message); process.exitCode = 1; } finally { await c.end(); }
})();
