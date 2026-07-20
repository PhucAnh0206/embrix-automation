import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../fixtures/page-factory';
import type { PrepaidAccountPayload } from '../../../pages/customer-hub/customer-management/create-account.page';
import type { PrepaidAccountWithOrderRow } from '../../../fixtures/create-prepaid-account.helper';

const dataFile = path.join(process.cwd(), 'test-data', 'jasec-prepaid-accounts.data.json');
const rows: PrepaidAccountWithOrderRow[] = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const row = rows[0];

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
    // Append a per-run random suffix so reruns don't collide on
    // customerId (unique constraint) and meter provisioningId
    // (also unique in order_service_provisions).
    const suffix = Date.now().toString().slice(-5);
    const customerId = `${row.accountInfo.customerId}-${suffix}`;
    const provisioningId = `${row.meter.provisioningId}${suffix}`;

    testLogger.log(`▶ Running TS-01 — ${customerId} / meter ${provisioningId}`);

    // ── Step 1: Crear contrato en modalidad prepago ──────────────────
    await page.navigateToHome();
    await searchAccountsPage.navigateViaNav();
    await createAccountPage.clickCreateNew();

    const payload: PrepaidAccountPayload = {
      accountInfo: { ...row.accountInfo, customerId },
      contact: row.contact,
      address: row.address,
      paymentProfile: row.paymentProfile,
      billingProfile: row.billingProfile,
    };

    const accountId = await createAccountPage.createPrepaidAccount(payload);
    testLogger.data('Account created', { accountId, customerId: row.accountInfo.customerId });
    expect(accountId).toMatch(/^(ACT|AC)-\d+$/);

    // ── Step 2: Crear nueva orden, agregar Paquete Prepago, meter ────
    await page.navigateToHome();
    await orderManagementPage.navigateViaNav();
    await orderManagementPage.clickCreateNewOrder();

    // Select the account we just created
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
    await orderManagementPage.addMeterProvisioningData(
      provisioningId,
      row.meter.lecturaInicialKwh,
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

    testLogger.log(`✓ TS-01 completed — account ${accountId}, order ${orderId} (SUBMITTED, meter ${provisioningId})`);
  });
});
