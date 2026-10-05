/**
 * Account ID with hidden or special characters is refused (or cleaned).
 *
 * Why: on jasec-preprod (2026-10-03) account "JASEC-20260920-001" was created in the Core UI
 * with a hidden TAB at the end of its id. core_engine.insert_jobs builds each job's JSON by
 * gluing the account id into text, so the TAB made it invalid JSON and the daily billing run
 * stopped for ALL 276 accounts. Huy asked for automation covering ids with special characters
 * at the end (newline, tab, ...). Team ticket: harden validation on the account ID field.
 *
 * PASS = the id is refused, or stored cleaned (no whitespace and none of | ' " \).
 * FAIL = stored as typed. Expected to FAIL until the validation fix lands.
 *
 * SAFETY - read before changing anything:
 *   An accepted bad id breaks the daily billing run for the WHOLE tenant until someone fixes it
 *   in the database. So this spec:
 *     - runs on jasec-dev ONLY (refuses any other TEST_ENV),
 *     - creates accounts WITHOUT an order. All 10 jobs in dev's DAILY schedule select accounts
 *       through a bill unit, invoice, price unit, subscription or accounting batch
 *       (checked against insert_jobs on dev, 2026-10-05), so an order-less account is never
 *       picked up. FINANCE_SYNC_ACCOUNT would pick it up, but it is not in the DAILY schedule.
 *     - asserts each created account has none of those rows, and FAILS loudly if it does,
 *     - never runs billing to "prove" the impact,
 *     - writes every accepted bad id to artifacts/account-id-validation-created.json.
 *
 *   npx playwright test --project=jasec-regression --grep '@acct-id-validation'
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../fixtures/jasec-fixtures';
import { uniqueRunSuffix, type PrepaidAccountWithOrderRow } from '../../../fixtures/create-prepaid-account.helper';
import { PrepaidSeedHelper, GraphQlBusinessError } from '../../../helpers/prepaid-seed.helper';
import { DbHelper, hasDbConfig } from '../../../helpers/db.helper';
import { TestLogger } from '../../../helpers/test-logger';
import { blockedIf } from '../../../helpers/blocked.helper';

const DEV_ONLY = process.env.TEST_ENV === 'jasec-dev';
const BAD = /[\s|'"\\]/;
const row: PrepaidAccountWithOrderRow = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json'), 'utf-8'))[0];

const INPUTS: Array<{ label: string; make: (base: string) => string }> = [
  { label: 'trailing TAB', make: b => `${b}\t` },
  { label: 'trailing newline', make: b => `${b}\n` },
  { label: 'trailing space', make: b => `${b} ` },
  { label: 'leading space', make: b => ` ${b}` },
  { label: 'pipe', make: b => b.replace('-', '|') },
  { label: 'single quote', make: b => b.replace('-', "'") },
  { label: 'double quote', make: b => b.replace('-', '"') },
  { label: 'backslash', make: b => b.replace('-', '\\') },
];

/** Records accepted bad ids so a person can clean them up. */
function recordCreated(entries: Array<{ label: string; storedId: string; path: string }>): void {
  if (!entries.length) return;
  const file = path.join(process.cwd(), 'artifacts', 'account-id-validation-created.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
  fs.writeFileSync(file, JSON.stringify([...prev, ...entries.map(e => ({ ...e, env: process.env.TEST_ENV, at: new Date().toISOString() }))], null, 2));
}

/** Fails closed if an accepted account could be picked up by the daily jobs. */
async function assertUnreachableByDailyJobs(db: DbHelper, storedId: string): Promise<void> {
  const r = await db.query<{ t: string; n: number }>(
    `SELECT 'subscription' t, count(*)::int n FROM core_engine.subscription WHERE accountid = $1
     UNION ALL SELECT 'price_unit', count(*)::int FROM core_engine.price_unit WHERE accountid = $1
     UNION ALL SELECT 'bill_unit', count(*)::int FROM core_engine.bill_unit WHERE accountid = $1
     UNION ALL SELECT 'invoice_unit', count(*)::int FROM core_engine.invoice_unit WHERE accountid = $1`, [storedId]);
  const found = r.filter(x => x.n > 0).map(x => `${x.t}=${x.n}`);
  expect(found, `DANGER: bad account ${JSON.stringify(storedId)} has ${found.join(', ')} - the daily billing ` +
    `run can pick it up and stop for EVERY account. Get it fixed in the database now.`).toEqual([]);
}

/** Look the account up by its unique customerId - the id itself is what is under test. */
async function storedIdFor(db: DbHelper, customerId: string): Promise<string | null> {
  for (let i = 0; i < 6; i++) {
    const r = await db.query<{ id: string }>(`SELECT id FROM core_engine.account WHERE customerid = $1`, [customerId]);
    if (r.length) return r[0].id;
    await new Promise(res => setTimeout(res, 2_000));
  }
  return null;
}

test.describe('Account ID with hidden or special characters @acct-id-validation', () => {
  test.beforeEach(() => {
    blockedIf(!DEV_ONLY, `runs on jasec-dev ONLY - an accepted bad id breaks billing for the whole tenant (TEST_ENV=${process.env.TEST_ENV})`);
    blockedIf(!hasDbConfig(), 'needs DB access to read what was stored');
  });

  test('API (createAccount): every special character is refused or cleaned @acct-id-validation', async () => {
    test.setTimeout(300_000);
    const logger = new TestLogger('acct-id-validation-api');
    const seed = new PrepaidSeedHelper(logger);
    const db = new DbHelper();
    await db.connect();
    const accepted: Array<{ label: string; storedId: string; path: string }> = [];
    try {
      for (const input of INPUTS) {
        const suffix = uniqueRunSuffix();
        const asked = input.make(`QAID-${suffix}`);
        const customerId = `E2EQAID-${suffix}`;
        let refusal = '';
        try {
          await seed.createAccountOnly({ id: asked, customerId, name: `E2EQAID ${suffix}` });
        } catch (e) {
          if (!(e instanceof GraphQlBusinessError)) throw e; // transport/auth failure is not a verdict
          refusal = String((e as Error).message).slice(0, 160);
        }
        const stored = await storedIdFor(db, customerId);
        if (stored === null) {
          console.log(`  PASS  ${input.label.padEnd(17)} refused${refusal ? `: ${refusal}` : ''}`);
          continue;
        }
        if (!BAD.test(stored)) {
          console.log(`  PASS  ${input.label.padEnd(17)} stored cleaned as ${JSON.stringify(stored)}`);
          continue;
        }
        accepted.push({ label: input.label, storedId: stored, path: 'api' });
        await assertUnreachableByDailyJobs(db, stored);
        console.log(`  FAIL  ${input.label.padEnd(17)} stored as typed: ${JSON.stringify(stored)}`);
        expect.soft(stored, `${input.label}: accepted and stored as ${JSON.stringify(stored)}`).not.toMatch(BAD);
      }
    } finally {
      recordCreated(accepted);
      await db.disconnect();
    }
  });

  // The UI is how it actually happened (pasted from a spreadsheet). TAB is the incident;
  // a browser strips a newline from a single-line input, which this records either way.
  for (const label of ['trailing TAB', 'trailing newline']) {
    test(`Core UI (Create Account): ${label} is refused or cleaned @acct-id-validation`, async ({
      page, searchAccountsPage, createAccountPage,
    }) => {
      test.setTimeout(300_000);
      const suffix = uniqueRunSuffix();
      const asked = INPUTS.find(i => i.label === label)!.make(`QAID-${suffix}`);
      const customerId = `${row.accountInfo.customerId}-${suffix}`;

      await page.navigateToHome();
      await searchAccountsPage.navigateViaNav();
      await createAccountPage.clickCreateNew();
      blockedIf(!(await createAccountPage.hasAccountIdField()),
        'the Create Account screen shows no "Account Id" field on this build - the UI path cannot be tested');

      let refusal = '';
      try {
        await createAccountPage.createPrepaidAccount({
          accountInfo: { ...row.accountInfo, customerId, clientId: `${row.accountInfo.clientId ?? 'NISE'}-${suffix}`, accountId: asked },
          contact: row.contact, address: row.address,
          paymentProfile: row.paymentProfile, billingProfile: row.billingProfile,
        });
      } catch (e) {
        if (!/Create Account failed/.test(String(e))) throw e;
        refusal = String((e as Error).message).slice(0, 160);
      }

      const db = new DbHelper();
      await db.connect();
      try {
        const stored = await storedIdFor(db, customerId);
        if (stored === null) {
          console.log(`  PASS  UI ${label}: refused${refusal ? ` - ${refusal}` : ''}`);
          return;
        }
        if (!BAD.test(stored)) {
          console.log(`  PASS  UI ${label}: stored cleaned as ${JSON.stringify(stored)}`);
          return;
        }
        recordCreated([{ label, storedId: stored, path: 'ui' }]);
        await assertUnreachableByDailyJobs(db, stored);
        expect(stored, `UI ${label}: accepted and stored as ${JSON.stringify(stored)} - the same shape that ` +
          `stopped the preprod billing run`).not.toMatch(BAD);
      } finally {
        await db.disconnect();
      }
    });
  }
});
