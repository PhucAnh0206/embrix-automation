/**
 * SEEDING, not a test of the product. Creates zero-usage prepaid contracts and
 * bills them over GraphQL, so the read-only billing specs (Block I, ts-07) have
 * real 0-30 kWh invoices on a tenant where MDR usage cannot be delivered yet -
 * no SFTP, no DB (JASEC prod build 1, 2026-09-30).
 *
 * Mirrors ts-10 steps 1-2: seed, top up, move the CCP clock FORWARD 20 days,
 * runPendingBill, invoiceAccount. The clock move is TENANT-GLOBAL, so this is
 * gated behind JASEC_SEED_RUN=true and must not run alongside other specs.
 *
 *   $env:JASEC_SEED_RUN='true'; npx playwright test --project=jasec-seed
 */
import { test, expect } from '@playwright/test';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { OrderOutcomeHelper } from '../../../../helpers/order-outcome.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix, assertQaMeter } from '../../../../fixtures/create-prepaid-account.helper';
import { shiftDate } from '../../../../helpers/accounting-gql.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';

const RUN_ENABLED = String(process.env.JASEC_SEED_RUN ?? '').trim().toLowerCase() === 'true';

const N = 2;

test('seed and bill zero-usage prepaid contracts', async () => {
  if (blockedIf(!RUN_ENABLED, 'JASEC_SEED_RUN is not "true" - this moves the tenant-global CCP clock')) return;
  const logger = new TestLogger('seed-zero-usage');
  const seed = new PrepaidSeedHelper(logger);
  const startDate = await seed.ccpDate();
  const accounts: string[] = [];

  for (let i = 0; i < N; i++) {
    const suffix = uniqueRunSuffix();
    const meter = assertQaMeter(`M-QABIL-${suffix}`);
    const { accountId } = await seed.seed({ meter, customerId: `E2EPROD0-${suffix}`, name: `E2EPROD0 ${suffix}` });
    const problems = await new OrderOutcomeHelper(logger).readAndVerify(accountId, { meter, bundleId: 'B-100000-E' });
    console.log(`seeded ${accountId} meter ${meter} on ${startDate}; outcome problems: ${JSON.stringify(problems)}`);
    await seed.topUp(accountId, 5000);
    accounts.push(accountId);
  }

  const billDate = shiftDate(startDate, 20);
  await seed.setCcpDate(billDate);
  console.log(`clock ${startDate} -> ${billDate}`);

  const results: string[] = [];
  for (const accountId of accounts) {
    const bill = await seed.runPendingBill(accountId);
    const invoiceId = bill?.id ? await seed.invoiceAccount(accountId, bill.id) : null;
    results.push(`${accountId}: billUnit=${bill?.id} total=${bill?.billTotal} status=${bill?.status} invoice=${invoiceId ?? 'REFUSED/none'}`);
  }
  console.log('\nRESULTS\n  ' + results.join('\n  '));
  expect(accounts.length).toBe(N);
});
