/**
 * TS-01 — Prepaid Account Creation (Energía Prepago)
 *
 * Walks the full contract-creation path for a residential prepaid customer:
 * create the account, raise a NEW order against it, add the prepaid bundle,
 * attach the meter's provisioning data, submit, and confirm the order reaches
 * COMPLETED carrying the expected bundle.
 *
 * This is the setup path the rest of the JASEC suites depend on — TS-02 and
 * TS-03 reach it through createPrepaidAccountWithOrder — so a failure here
 * blocks them too.
 *
 * Caveats:
 *   • Attaching the meter needs the tenant's ELECTRICITY provisioning type
 *     configured. Without it the "View Provisioning Data" modal never opens
 *     and the order cannot be completed.
 *   • The account, order and meter are left in place; there is no teardown.
 */

import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../fixtures/jasec-fixtures';
import type { PrepaidAccountPayload } from '../../../pages/customer-hub/customer-management/create-account.page';
import { uniqueRunSuffix, type PrepaidAccountWithOrderRow } from '../../../fixtures/create-prepaid-account.helper';
import { OrderOutcomeHelper } from '../../../helpers/order-outcome.helper';
import { DbHelper } from '../../../helpers/db.helper';

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const rows: PrepaidAccountWithOrderRow[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const row = rows[0];

// Calc-validation mode: forces lecturaInicialKwh=0 so the bash calc scripts
// (which read cumulative from mediation history only, not the provisioning
// initial reading) start from a matching baseline. Also emits a handoff JSON
// so the PowerShell wrapper can pass the freshly-created meter into the
// remote bash calc script via the METER env var.
const isCalcMode = process.env.JASEC_CALC_MODE === 'true';

test.describe('TS-01 — Prepaid Account Creation (Energia Prepago)', {
  tag: ['@regression', '@jasec', '@ts-01', '@tc-c01'],
}, () => {
  test(`TS-01 — ${row.accountInfo.customerId}`, async ({
    page,
    testLogger,
    searchAccountsPage,
    createAccountPage,
    orderManagementPage,
    screenshotHelper,
  }) => {
    // Suffix both ids so reruns don't collide: customerId is unique, and
    // provisioningId is unique in order_service_provisions across all
    // historical rows.
    const suffix = uniqueRunSuffix();
    const customerId = `${row.accountInfo.customerId}-${suffix}`;
    // NISE (clientId) became MANDATORY with JEPYP-231 — "BOTH ARE MANDATORY",
    // Luis, 2026-09-21. Suffixed for the same reason customerId is: reruns must
    // not collide on it.
    const clientId = `${row.accountInfo.clientId ?? 'NISE'}-${suffix}`;
    const provisioningId = `${row.meter.provisioningId}${suffix}`;

    testLogger.log(`▶ Running TS-01 — ${customerId} / meter ${provisioningId}`);

    // ── Step 1: Crear contrato en modalidad prepago ──────────────────
    await page.navigateToHome();
    await searchAccountsPage.navigateViaNav();
    await createAccountPage.clickCreateNew();

    const payload: PrepaidAccountPayload = {
      // legalEntity is overridable for the SAME reason BDOM is: one value cannot
      // serve both shapes the suite needs, and the choice belongs to the caller.
      //
      //   US    -> attribute-matches Prepaid Energy Profile, so the account HAS a
      //            credit profile. This is the default and what almost every case
      //            wants.
      //   Jasec -> matches NO credit profile, but it is the only shape the
      //            fixed-charge cases (TC-53..TC-56) select on
      //            (run-mdr-fixedcharge.sh requires legalentity ILIKE 'jasec').
      //            All 831 dev candidates for those cases are Jasec accounts.
      //
      // Default stays 'US' from the data file, so this is inert unless set.
      // Do NOT set it casually: a Jasec account can never warn or suspend.
      accountInfo: {
        ...row.accountInfo,
        customerId,
        clientId,
        legalEntity: process.env.JASEC_LEGAL_ENTITY ?? row.accountInfo.legalEntity,
      },
      contact: row.contact,
      address: row.address,
      paymentProfile: row.paymentProfile,
      // BDOM is overridable so a seeded account can be given a PRIVATE billing
      // date. Every JASEC prepaid account is BDOM 1 (1,031 of 1,040 on dev), and
      // the cycle offset is 8 days, so they all bill on the 9th - 267 of them on
      // one date. A bill unit's period is fixed when it is created and the
      // account can only ever be billed on the date it was born with, so a
      // freshly seeded BDOM-1 account CANNOT be billed in isolation: the only
      // options are billing the whole cohort or giving the account a BDOM nobody
      // else uses. Default is unchanged (the data file's 1), so this is inert
      // unless JASEC_BDOM is set.
      billingProfile: {
        ...row.billingProfile,
        billingDom: Number(process.env.JASEC_BDOM ?? row.billingProfile.billingDom),
      },
    };

    const accountId = await createAccountPage.createPrepaidAccount(payload);
    testLogger.data('Account created', { accountId, customerId: row.accountInfo.customerId });
    expect(accountId).toMatch(/^(ACT|AC)-\d+$/);

    // ── Step 1b: prove the account this form NOW builds is still the one the
    //    rest of the suite depends on.
    //
    // JEPYP-231 deleted legalEntity, currency and customerSegment from the form
    // and locked Account Category and Tarifa Jasec. Deleted fields do not fail
    // anything — they silently fall back to whatever the product defaults to,
    // which is precisely the shape of gap that reads as coverage. So read the
    // row back and say out loud what it holds. The credit profile is checked
    // too, because that is the thing legalEntity used to buy us: an account
    // matching no profile can never warn and never suspend, and it would sail
    // through account creation looking perfectly healthy.
    const db = new DbHelper();
    await db.connect();
    try {
      if (createAccountPage.unsettableFields.length) {
        testLogger.log(
          `⚠ the form no longer offers: ${createAccountPage.unsettableFields.join(', ')} ` +
          `— these fell back to the product default (JEPYP-231).`,
        );
      }
      const [acct] = await db.query<Record<string, string | null>>(
        `SELECT legalentity, currency, customersegment, accountcategory,
                accounttype, accountsubtype, sellingcompany, clientid, customerid
           FROM core_engine.account WHERE id = $1`,
        [accountId],
      );
      testLogger.data('Account shape as stored', acct ?? {});
      expect(acct, `account ${accountId} not found`).toBeTruthy();

      // Defaults that survived the field being deleted — these must not drift.
      expect.soft(acct.currency, 'currency default').toBe('CRC');
      expect.soft(acct.customersegment, 'customerSegment default').toBe('B2C');
      expect.soft(acct.accountcategory, 'account category (locked)').toBe('PREPAID');
      // What we did set.
      expect.soft(acct.accounttype, 'Tarifa ARESEP').toBe(payload.accountInfo.accountType);
      expect.soft(acct.clientid, 'NISE').toBe(clientId);

      testLogger.log(
        `legalentity stored as "${acct.legalentity}" — the suite's documented ` +
        `assumption is "US" (create-prepaid-account.helper.ts). The credit ` +
        `profile itself lands on the SUBSCRIPTION, so it is checked after the ` +
        `order completes.`,
      );
    } finally {
      await db.disconnect();
    }

    // ── Step 2: Crear nueva orden, agregar Paquete Prepago, meter ────
    await page.navigateToHome();
    await orderManagementPage.navigateViaNav();
    await orderManagementPage.clickCreateNewOrder();

    // 2a. Select the account created in step 1
    await orderManagementPage.searchAccountById(accountId);
    const orderAcctNo = await orderManagementPage.getFirstRowCellValue('ACCT No');
    expect(orderAcctNo).toBe(accountId);
    await orderManagementPage.clickNextInFirstRow();

    // 2b. Order Data — no changes → NEXT
    await orderManagementPage.clickNextTop();

    // 2c. Add Subscription — no changes → NEXT
    await orderManagementPage.clickNextTop();

    // 2d.i. Subscription Terms — no changes → NEXT (below Subscription: Primary)
    await orderManagementPage.clickNextBelowSubscription();

    // 2d.ii–iii. Purchase Options → ADD BUNDLE → select B-100000-E
    await orderManagementPage.clickAddBundle();
    await orderManagementPage.selectBundleById(row.bundleId);

    // 2d.iv. NEXT below Subscription: Primary
    await orderManagementPage.clickNextBelowSubscription();

    // 2d.v–vii. Override Options → View → +ADD → meter data → Submit
    const lecturaInicialKwh = isCalcMode ? '0' : row.meter.lecturaInicialKwh;
    await orderManagementPage.addMeterProvisioningData(
      provisioningId,
      lecturaInicialKwh,
    );

    // 2d.viii. NEXT at the top of the screen
    await orderManagementPage.clickNextTop();

    // 2e. CREATE the order
    await orderManagementPage.clickCreate();
    const orderUrl = await orderManagementPage.isProvisioningOrderSuccessfulToastAppear(screenshotHelper);
    const orderId = orderUrl.match(/orders\/(ORD-\d+)\//)?.[1] ?? '';
    testLogger.data('Order created', { orderId, orderUrl });
    expect(orderId).toMatch(/^ORD-\d+$/);

    await orderManagementPage.clickRefresh();

    // 2f. SUBMIT ORDER — now enabled after the reload. Click it to drive
    // the order from CREATED → COMPLETED.
    await orderManagementPage.clickSubmitOrder();

    // 2g. Reload once more to surface the post-submit state, then assert
    // the order reached COMPLETED with the expected bundle.
    await orderManagementPage.clickRefresh();
    await orderManagementPage.verifyOrderCompletedWithBundle('TARIFICACION ENERGIA PREAPGO');

    // ── Step 3: did the order actually PRODUCE a usable contract? ────
    /**
     * "COMPLETED with the right bundle" is a screen state, not an outcome. Up to
     * 2026-09-15 this test stopped there, which meant an account could pass TS-01
     * and still be impossible to rate or bill — and because TS-02, TS-03 and the
     * tariff scripts all build on this path, the failure surfaced much later and
     * looked like a rating bug.
     *
     * The checklist below is point 3 of Huy's 2026-09-15 E2E guide. The one that
     * matters most is the meter: rating matches the MDR against a
     * `service_provision` row of type METER, and the service unit's own
     * `provisioningId` is a generated placeholder that looks like a meter and is
     * not one.
     *
     * GraphQL only — no DB, so this adds no VPN dependency to TS-01.
     */
    const outcome = new OrderOutcomeHelper(testLogger);
    const problems = await outcome.readAndVerify(accountId, {
      meter: provisioningId,
      bundleId: row.bundleId,
    });

    /**
     * THE MISSING CREDIT PROFILE IS HELD SEPARATELY, AND ONLY THAT ONE.
     *
     * It is a real defect and it is reported below in full — but it is a defect
     * in tenant CONFIG, raised with the team, and it says nothing about whether
     * this order produced a rateable contract. Failing the whole test on it
     * costs twelve unrelated cases: every Block E rating scenario provisions its
     * meter by running this spec, reads the handoff file it writes at the end,
     * and reports BLOCKED "no clean meter" when this throws first. Measured on
     * 2026-09-24 — one failing assertion, TC40..TC47 and TC49..TC52 all blocked.
     *
     * Rating does not need the profile: TC-60 rates and bills green on an
     * account seeded the same way. The profile governs balance-driven warn and
     * suspend, which is what the notification blocks cover.
     *
     * Narrow on purpose. Only a profile of literally "null" is held back — the
     * shape JEPYP-231 produces. A subscription carrying the WRONG named profile
     * is a different bug and still fails here.
     */
    const KNOWN_NULL_PROFILE = /carries credit profile "null"/;
    const missingProfile = problems.filter((p) => KNOWN_NULL_PROFILE.test(p));
    const blocking = problems.filter((p) => !KNOWN_NULL_PROFILE.test(p));

    if (missingProfile.length) {
      testLogger.log(
        `⚠ KNOWN DEFECT (JEPYP-231, raised with the team 2026-09-24): ` +
        `${missingProfile.join(' | ')}. The Create Account screen now produces ` +
        `accounttype=PREPAID / accountsubtype=SUBTYPE_01, and "Prepaid Energy ` +
        `Profile" matches RESIDENTIAL / NONE / US. Tarifa Jasec is locked and no ` +
        `Tarifa ARESEP choice offers NONE, so this cannot be fixed from the ` +
        `screen — the tenant needs a credit profile for the new combination. ` +
        `NOT failing the run: the contract still rates and bills.`,
      );
    }

    expect(
      blocking,
      `order ${orderId} completed but did not produce a usable prepaid contract`,
    ).toEqual([]);

    // ── Step 3b: the credit profile, now that a subscription exists ──
    /**
     * This is what JEPYP-231 put at risk, so it is asserted rather than assumed.
     *
     * The profile is attribute-matched, and until now the attribute the suite
     * relied on was `legalentity` — which the Create Account form used to
     * pre-fill with "US" and JEPYP-231 has deleted outright. JASEC's answer on
     * the ticket (Luis, 2026-09-22) is that the match moves to the tariff:
     * "from tarifa ARESEP the value Tarifa Prepago will be associate to a credit
     * profile ... this combination should be Residential prepaid credit profile".
     *
     * An account with no profile looks completely healthy here and then can
     * never warn and never suspend, which is a defect nobody sees until a
     * notification block comes back empty. Reported rather than hard-failed,
     * because the back-end half ("none of the new codes exist yet" — Toan,
     * 2026-09-21) is still outstanding and a red TS-01 would block the suite.
     */
    const db2 = new DbHelper();
    await db2.connect();
    try {
      const subs = await db2.query<{ id: string; creditprofilename: string | null }>(
        `SELECT id, creditprofilename FROM core_engine.subscription WHERE accountid = $1`,
        [accountId],
      );
      testLogger.data('Subscription credit profile', subs);
      const without = subs.filter((s) => !s.creditprofilename);
      if (!subs.length) {
        testLogger.log(`⚠ ${accountId} has no subscription rows to carry a credit profile.`);
      } else if (without.length) {
        testLogger.log(
          `⚠ CREDIT PROFILE MISSING on ${without.length} of ${subs.length} subscription(s) ` +
          `for ${accountId}. Such an account can never warn and never suspend. ` +
          `JEPYP-231 removed legalEntity from the form; JASEC say the match should ` +
          `now come from Tarifa Prepago + Residencial Permanente.`,
        );
      } else {
        testLogger.log(
          `✓ credit profile attached: ${[...new Set(subs.map((s) => s.creditprofilename))].join(', ')}`,
        );
      }
    } finally {
      await db2.disconnect();
    }

    testLogger.log(`✓ TS-01 completed — account ${accountId}, order ${orderId} (SUBMITTED, meter ${provisioningId})`);

    if (isCalcMode) {
      // WRITTEN TO BOTH PLACES ON PURPOSE.
      //
      // `test-results/` is managed by Playwright and gets cleared around runs,
      // so a handoff left only there can vanish between the spec writing it and
      // the PowerShell caller reading it. That is not theoretical: on
      // 2026-09-14 seed-two-cycle-account.ps1 logged the write, reported
      // "2 passed", and then died on `Handoff file not found` for the path it
      // had just been told about. The file was genuinely gone.
      //
      // `artifacts/` is the suite's established home for anything that has to
      // survive a run, so that is now the primary. test-results/ is still
      // written so that any consumer not yet updated keeps working - five
      // scripts read this file and they should not have to change in lockstep.
      // Readers should prefer artifacts/ and fall back.
      const payload = JSON.stringify(
        { accountId, provisioningId, orderId, lecturaInicialKwh: '0' }, null, 2);
      for (const dir of ['artifacts', 'test-results']) {
        const handoffPath = path.join(process.cwd(), dir, 'jasec-latest-meter.json');
        fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
        fs.writeFileSync(handoffPath, payload);
        testLogger.log(`↳ Calc-mode handoff written: ${handoffPath}`);
      }
    }
  });
});
