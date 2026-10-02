/**
 * TC-61 variant TC61X - a starting reading ("Lectura Inicial kWh") that is not a number.
 *
 * The field is free text (flexAttr16: String) and the Core UI accepts any characters.
 * Found 2026-10-02 on jasec-dev (finding F5): `abc`, `12,300` and `#$%` were all
 * accepted, and the order then died at provisioning - update_service_provision()
 * casts the value ::NUMERIC - leaving PROVISIONING_ERROR with the raw SQL error as
 * its reason and no subscription, service or meter (ORD-2072/2073/2074).
 *
 * The assertion takes no side on HOW the team fixes it. Either answer is a PASS:
 *   - the UI refuses the value at entry (the meter modal will not close), or
 *   - the order completes and the meter exists for rating.
 * FAIL is what happens today: the value is accepted and the order breaks later.
 *
 * The account is created over GraphQL - account creation is not under test here;
 * the ORDER screen is, so the order goes through the Core UI like a CSR would.
 *
 *   npx playwright test --project=jasec-regression --grep '@tc-61x'
 */

import { test, expect } from '../../../fixtures/jasec-fixtures';
import { uniqueRunSuffix, assertQaMeter } from '../../../fixtures/create-prepaid-account.helper';
import { PrepaidSeedHelper } from '../../../helpers/prepaid-seed.helper';
import { DbHelper, hasDbConfig } from '../../../helpers/db.helper';
import { blockedIf } from '../../../helpers/blocked.helper';

const BUNDLE = 'B-100000-E';
// BILLING_ERROR is NOT terminal here: ORD-2076 (dev, 2026-10-02) showed it with an
// empty reason for about a minute, then settled at PROVISIONING_ERROR.
const TERMINAL = ['COMPLETED', 'PROVISIONING_ERROR', 'FAILED', 'CANCELLED'];

/** One test per INPUT CLASS - letters, a comma-formatted number, symbols. */
const INPUTS: Array<{ label: string; value: string }> = [
  { label: 'letters', value: 'abc' },
  { label: 'comma-formatted number', value: '12,300' },
  { label: 'special characters', value: '#$%' },
];
// CONTROL: a valid number through the identical path. Must COMPLETE - if it does not,
// the subject is wrong and the three verdicts above mean nothing.
if (process.env.JASEC_TC61X_CONTROL === 'true') INPUTS.push({ label: 'control - a valid number', value: '100' });

test.describe('TC61X - starting reading that is not a number @tc-61x', () => {
  for (const input of INPUTS) {
    test(`Lectura Inicial = "${input.value}" (${input.label}) is refused or handled @tc-61x`, async ({
      page, testLogger, orderManagementPage,
    }) => {
      test.setTimeout(600_000);
      blockedIf(!hasDbConfig(), 'needs DB access to read the order outcome');

      const suffix = uniqueRunSuffix();
      const meter = assertQaMeter(`M-QAINV-${suffix}`);
      const accountId = await new PrepaidSeedHelper(testLogger).createAccountOnly({
        customerId: `E2EINV-${suffix}`, name: `E2EINV ${suffix}`,
      });
      testLogger.log(`account ${accountId}, meter ${meter}, Lectura Inicial "${input.value}"`);

      // The order, through the Core UI - same steps as TS-01.
      await page.navigateToHome();
      await orderManagementPage.navigateViaNav();
      await orderManagementPage.clickCreateNewOrder();
      await orderManagementPage.searchAccountById(accountId, { clearFilters: true });
      await orderManagementPage.clickNextInFirstRow();
      await orderManagementPage.clickNextTop();
      await orderManagementPage.clickNextTop();
      await orderManagementPage.clickNextBelowSubscription();
      await orderManagementPage.clickAddBundle();
      await orderManagementPage.selectBundleById(BUNDLE);
      await orderManagementPage.clickNextBelowSubscription();

      const modal = await orderManagementPage.tryMeterProvisioningData(meter, input.value);
      if (modal.stillOpen) {
        // Refused at entry - the outcome the fix is expected to produce.
        console.log(`  PASS - the UI refused "${input.value}" at entry. Message: ${modal.message || '(none visible)'}`);
        if (!modal.message) testLogger.log('note: refused, but no message text was found in the modal');
        return;
      }

      // Accepted: create + submit, then judge the ORDER OUTCOME from the database.
      await orderManagementPage.clickNextTop();
      await orderManagementPage.clickCreate();
      await page.waitForURL(/orders\/ORD-\d+\//, { timeout: 60_000 }).catch(() => { });
      const orderId = page.url().match(/orders\/(ORD-\d+)\//)?.[1] ?? '';
      expect(orderId, `"${input.value}" was accepted but no order was created`).toMatch(/^ORD-\d+$/);
      await orderManagementPage.clickRefresh();
      await orderManagementPage.clickSubmitOrder();

      const db = new DbHelper();
      await db.connect();
      try {
        let status = ''; let reason = '';
        for (let i = 0; i < 36 && !TERMINAL.includes(status); i++) {
          await new Promise(r => setTimeout(r, 5_000));
          const r = await db.query<{ status: string; reason: string }>(
            `SELECT coalesce(status,'') AS status, coalesce(reason,'') AS reason FROM core_oms."order" WHERE id = $1`, [orderId]);
          status = r[0]?.status ?? ''; reason = r[0]?.reason ?? '';
        }
        const sp = await db.query<{ v: string | null }>(
          `SELECT flexattr16 AS v FROM core_engine.service_provision WHERE provisioningid = $1 AND type = 'METER'`, [meter]);
        console.log(`  ${orderId}: ${status}; meter row ${sp.length ? `present (stored "${sp[0].v}")` : 'ABSENT'}`);

        const known = /invalid input syntax for type numeric/i.test(reason)
          ? ' Known (F5): the value was accepted, then the ::NUMERIC cast failed at provisioning.' : '';
        expect(status,
          `"${input.value}" was ACCEPTED by the UI and the order ended ${status || '(no terminal status in 3 min)'} - ` +
          `the customer gets no service.${known} Reason: ${reason.slice(0, 160)}`).toBe('COMPLETED');
        expect(sp.length, `${orderId} COMPLETED but meter ${meter} has no METER service_provision row - nothing can rate`)
          .toBe(1);
        console.log(`  PASS - "${input.value}" was accepted and the order completed (stored as "${sp[0].v}")`);
      } finally {
        await db.disconnect();
      }
    });
  }
});
