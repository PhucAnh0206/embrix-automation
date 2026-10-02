/**
 * SEEDING for TC-61 variant TC61N - a meter whose starting reading was LEFT EMPTY.
 *
 * Why not ts-01: the Core UI marks "Lectura Inicial kWh" required (red asterisk,
 * red cross on an empty box) and the meter modal will not close on Submit, so an
 * empty starting reading cannot be created through the wizard (JASEC prod build 2,
 * 2026-10-02). A NULL can only arrive through the API order path or migrated data -
 * which is exactly the case MR !151 protects. This seeds through that path:
 * createOrder with the meter in provisioningList and no starting reading.
 *
 * Proves the subject before handing it over: service_provision.flexattr16 must be
 * NULL/empty. If the order path ever starts defaulting it, the case is BLOCKED, not
 * silently turned into the "typed 0" case.
 *
 * Writes the same handoff JSON ts-01 writes in calc mode, so run-block-E.ps1
 * reads it the same way. Gated:
 *
 *   $env:JASEC_SEED_EMPTY_START='true'
 *   npx playwright test --project=jasec-seed --grep '@seed-empty-start'
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { DbHelper } from '../../../../helpers/db.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN_ENABLED = String(process.env.JASEC_SEED_EMPTY_START ?? '').trim().toLowerCase() === 'true';

test('seed a meter with an empty starting reading @seed-empty-start', async () => {
  if (blockedIf(!RUN_ENABLED, 'JASEC_SEED_EMPTY_START is not "true"')) return;
  test.setTimeout(180_000);
  const logger = new TestLogger('seed-empty-start-reading');
  const seed = new PrepaidSeedHelper(logger);

  const suffix = uniqueRunSuffix();
  const meter = assertQaMeter(`M-QANUL-${suffix}`);
  const { accountId, orderId } = await seed.seed({ meter, customerId: `E2ENUL-${suffix}`, name: `E2ENUL ${suffix}` });

  // Read the stored starting reading back - the subject must really be NULL.
  const db = new DbHelper();
  await db.connect();
  let stored: { found: boolean; start: string | null; initial: string | null } = { found: false, start: null, initial: null };
  try {
    for (let i = 0; i < 12 && !stored.found; i++) {
      const rows = await db.query<{ f16: string | null; f1: string | null }>(
        `SELECT flexattr16 AS f16, flexattr1 AS f1 FROM core_engine.service_provision
          WHERE provisioningid = $1 AND type = 'METER' LIMIT 1`, [meter]);
      if (rows.length) stored = { found: true, start: rows[0].f16, initial: rows[0].f1 };
      else await new Promise(r => setTimeout(r, 5_000));
    }
  } finally {
    await db.disconnect();
  }
  console.log(`seeded ${accountId} / ${orderId}, meter ${meter}: flexattr16=${JSON.stringify(stored.start)} flexattr1=${JSON.stringify(stored.initial)}`);

  blockedIf(!stored.found, `no METER service_provision row for ${meter} after 60s - the order did not provision`);
  blockedIf((stored.start ?? '').trim() !== '' || (stored.initial ?? '').trim() !== '',
    `the API order path stored a starting reading (flexattr16=${stored.start}, flexattr1=${stored.initial}) - ` +
    `the empty-start subject cannot be built this way`);

  const payload = JSON.stringify({ accountId, provisioningId: meter, orderId, lecturaInicialKwh: '' }, null, 2);
  for (const dir of ['artifacts', 'test-results']) {
    const p = path.join(process.cwd(), dir, 'jasec-latest-meter.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, payload);
    logger.log(`handoff written: ${p}`);
  }
  expect(accountId).toMatch(/^ACT-/);
});
