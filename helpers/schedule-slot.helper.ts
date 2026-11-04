import * as fs from 'fs';
import * as path from 'path';
import { test } from '@playwright/test';
import { DbHelper } from './db.helper';
import { tenantArtifactPath } from './tenant-paths';

/**
 * A date that already holds a job schedule, made usable again (test tenants only: AWS dev / preprod, OCI dev; 2026-10-28).
 *
 * A date holds one schedule per frequency (DAILY, SCHEDULED), and createJobSchedule refuses a second one
 * (SCHEDULE_EXISTS); the Core UI Daily Schedule screen opens the existing one instead. The specs used to answer a taken
 * date by trying other billing days or jumping the clock a month or more ahead - which left unbilled QA accounts
 * behind and, on big jumps, billed every account due in between.
 *
 * VERIFIED on preprod 2026-10-28 (re-run of 2027-01-13, whose full DAILY had COMPLETED: 5 invoices, 102 credit-limit
 * actions, an EBS extract): deleting the run and processing a fresh full DAILY billed ONLY the account that had become
 * due since (+1 invoice, its 2 mails, its journal rows). Nothing of the first run was billed, mailed, cut or extracted
 * again (EBS headers and accounting entries +0); credit-limit actions only acted on the current debt state, as any
 * daily does. What is lost is the deleted run's own record - so every deleted row is written to
 * artifacts/<tenant>/schedule-reclaims/ first. Same result on OCI dev (re-run of the COMPLETED full DAILY of
 * 2026-09-17: only the newly due account was billed; earlier invoices, mails and the EBS extract not repeated).
 *
 * Never on another tenant (prod included), never a PROCESSING run (a live job). JASEC_RECLAIM_SLOTS=false turns it off.
 */
const RECLAIM_TENANTS = ['jasec-dev', 'jasec-preprod', 'jasec-oci-dev'];

export interface ScheduleSlot { id: string; frequency: string; status: string }

export function reclaimAllowed(): boolean {
  return RECLAIM_TENANTS.includes((process.env.TEST_ENV ?? '').trim()) &&
    (process.env.JASEC_RECLAIM_SLOTS ?? '').trim().toLowerCase() !== 'false';
}

export async function schedulesOn(db: DbHelper, date: string): Promise<ScheduleSlot[]> {
  return db.query<ScheduleSlot>(
    `SELECT id, coalesce(schedulefrequency,'') AS frequency, coalesce(status,'') AS status
       FROM core_engine.job_schedule WHERE scheduledate::date = $1::date ORDER BY id`, [date]);
}

/** A date a run can use: free now, or reclaimable (dev / preprod, and no PROCESSING run). Deletes nothing. */
export async function dateUsable(db: DbHelper, date: string): Promise<boolean> {
  const taken = await schedulesOn(db, date);
  return !taken.length || (reclaimAllowed() && !taken.some((s) => s.status === 'PROCESSING'));
}

/**
 * Make `date` (or only its `frequency` schedule) free. Returns free=false with the reason when it cannot: a run still
 * PROCESSING, or a tenant where reclaiming is not allowed. Callers BLOCK on free=false exactly as they did on a taken
 * date before.
 *
 * `anyTenant`: only for tests/jasec/probes/probe-rerun-completed-date.spec.ts, the experiment that qualifies a NEW tenant before
 * it joins RECLAIM_TENANTS. Prod (`jasec`) is refused whatever is passed.
 */
export async function ensureDateFree(
  db: DbHelper, date: string,
  opts: { frequency?: string; log?: (m: string) => void; anyTenant?: boolean } = {},
): Promise<{ free: boolean; reclaimed: ScheduleSlot[]; reason?: string }> {
  const log = opts.log ?? ((m: string) => console.log(`  ${m}`));
  const taken = (await schedulesOn(db, date)).filter((s) => !opts.frequency || s.frequency === opts.frequency);
  if (!taken.length) return { free: true, reclaimed: [] };
  const desc = taken.map((s) => `${s.id} ${s.frequency} ${s.status}`).join(', ');
  const tenant = (process.env.TEST_ENV ?? '').trim();
  const allowed = opts.anyTenant ? !!tenant && tenant !== 'jasec' : reclaimAllowed();
  if (!allowed) return { free: false, reclaimed: [], reason: `${date} already holds ${desc} (reclaiming a date is for ${RECLAIM_TENANTS.join(' / ')} only)` };
  const live = taken.filter((s) => s.status === 'PROCESSING');
  if (live.length) return { free: false, reclaimed: [], reason: `${date} holds a run that is still PROCESSING (${live.map((s) => s.id).join(', ')}) - never deleted` };

  // Keep the record of what is deleted: the schedule rows and their job lists, as they were.
  const ids = taken.map((s) => s.id);
  const heads = await db.query(`SELECT * FROM core_engine.job_schedule WHERE id = ANY($1)`, [ids]);
  const lists = await db.query(`SELECT * FROM core_engine.job_schedule_list WHERE id = ANY($1) ORDER BY id, index`, [ids]);
  let by = '';
  try { by = test.info().titlePath.join(' > '); } catch { /* not inside a test */ }
  const file = tenantArtifactPath('schedule-reclaims', `${date}_${ids.join('-')}_${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ date, reclaimedAt: new Date().toISOString(), by, schedules: heads, jobLists: lists }, null, 1));

  for (const id of ids) {
    // Children first: job_schedule_list_id_fkey has no ON DELETE CASCADE.
    await db.query(`DELETE FROM core_engine.job_schedule_list WHERE id = $1`, [id]);
    await db.query(`DELETE FROM core_engine.job_schedule WHERE id = $1`, [id]);
  }
  const left = (await schedulesOn(db, date)).filter((s) => !opts.frequency || s.frequency === opts.frequency);
  log(`reclaimed ${date}: deleted ${desc} (record kept in ${path.relative(process.cwd(), file)})`);
  try { test.info().annotations.push({ type: 'schedule-reclaimed', description: `${date}: ${desc}` }); } catch { /* not inside a test */ }
  return left.length
    ? { free: false, reclaimed: taken, reason: `${date} still holds ${left.map((s) => s.id).join(', ')} after the reclaim` }
    : { free: true, reclaimed: taken };
}
