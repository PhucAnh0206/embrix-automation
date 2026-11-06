/**
 * EVIDENCE VIDEO for JEPYP-475 "Fix Balance for service cancelation" - one happy case, recorded step by step for the
 * team (attach the .webm to the ticket). Not an official case: the full checks are account/ts-04 (TC-04, TC-154).
 *
 * Ticket: "When a service has an end date or is canceled the balance remains on the canceled service. The balance
 * should be transferred to the new service."
 *
 * Story on screen (captions at the top of the video):
 *   1. a prepaid customer with a CRC 522 credit (real top-up) on service 1 - Core UI Services + Balances
 *   2. service 1 is cancelled IN CORE UI (Services > Place Order: CANCEL > reason > CREATE > Submit order)
 *   3. a new service (new meter) IN CORE UI (Order Management > Create new order wizard) - Balances show the 522 on it,
 *      Customer Activity "Saldo a favor ... trasladado", Self Care View Balances
 *   4. summary from the database: cancelled service 0, new service -522, total unchanged
 * Setup only (account + first service + the 522 top-up) goes through the Embrix API; the cancel and the new order are
 * clicked in Core UI (Anh 10-19). Pace: 2x faster than the first takes (Anh 10-19).
 *
 * MUTATING: seeds one QA account (M-QA meters), a top-up, CANCEL + NEW orders. No clock move.
 *   run-projects.ps1 -Tenant preprod -Name jepyp475-video -Projects jasec-evidence-video -Env @{JASEC_EVIDENCE_RUN='true'}
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../../../fixtures/jasec-fixtures';
import { PrepaidSeedHelper } from '../../../../helpers/prepaid-seed.helper';
import { DbHelper } from '../../../../helpers/db.helper';
import { TestLogger } from '../../../../helpers/test-logger';
import { uniqueRunSuffix, assertQaMeter, attachToAccountInSelfCare } from '../../../../fixtures/create-prepaid-account.helper';
import { blockedIf } from '../../../../helpers/blocked.helper';
import { AgentScreens } from '../../../../helpers/agent-screens.helper';
import { ServicesPage } from '../../../../pages/customer-hub/customer-management/account-details/subscription-data/services.page';
import { BillsPage } from '../../../../pages/customer-hub/customer-management/account-details/billing-data/bills.page';
import { SuspendResumeOrderPage } from '../../../../pages/customer-hub/order-management/suspend-resume-order.page';
import { AccountInfoPage } from '../../../../pages/customer-hub/customer-management/account-details/account-data/account-info.page';
import { poll } from '../../../../helpers/poll.helper';
import { subscriptions, orderSettled } from '../../../../helpers/subscription-state.helper';
import { ON_JASEC_PROD, PROD_REFUSAL } from '../../../../helpers/prod-guard';

// Creates or changes data: never on JASEC production (the client's live environment).
test.skip(ON_JASEC_PROD, PROD_REFUSAL);

const RUN = String(process.env.JASEC_EVIDENCE_RUN ?? '').trim().toLowerCase() === 'true';
const CREDIT = 522;



/** A caption bar at the top of the screen (a player's controls cover the bottom), kept long enough to read. Re-added after every page load. */
async function caption(page: Page, title: string, detail = '', holdMs = 2_400) {
  await page.evaluate(([t, d]) => {
    document.getElementById('qa-caption')?.remove();
    const el = document.createElement('div');
    el.id = 'qa-caption';
    el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:rgba(10,30,60,.92);color:#fff;' +
      'font:600 20px/1.35 Segoe UI,Arial,sans-serif;padding:14px 24px;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.35)';
    el.innerHTML = `<div>${t}</div>` + (d ? `<div style="font-weight:400;font-size:16px;opacity:.9;margin-top:4px">${d}</div>` : '');
    document.body.appendChild(el);
  }, [title, detail]);
  await page.waitForTimeout(holdMs);
}

/** Outline what the viewer should look at. */
async function mark(loc: Locator) {
  await loc.scrollIntoViewIfNeeded().catch(() => { });
  await loc.evaluate(el => { (el as HTMLElement).style.outline = '4px solid #ff3b30'; (el as HTMLElement).style.outlineOffset = '2px'; }).catch(() => { });
}

/** A full-screen title card (about:blank page content). */
async function card(page: Page, lines: string[], holdMs = 3_400) {
  await page.setContent(`<html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0a1e3c;color:#fff;font-family:Segoe UI,Arial,sans-serif"><div style="max-width:1100px;padding:40px">
    ${lines.map((l, i) => i === 0 ? `<h1 style="font-size:34px;margin:0 0 24px">${l}</h1>` : `<p style="font-size:21px;line-height:1.5;margin:8px 0">${l}</p>`).join('')}
    </div></body></html>`);
  await page.waitForTimeout(holdMs);
}

test.describe('JEPYP-475 evidence video - the balance follows the customer to the new service', () => {
  test.use({ ccpBaseline: null });   // no clock move in this story
  test.skip(!RUN, 'GATED: seeds an account, a top-up, CANCEL + NEW orders. Set JASEC_EVIDENCE_RUN=true.');
  test.setTimeout(1_200_000);

  test('credit CRC 522 on a cancelled service moves to the new service @jepyp-475 @evidence',
    async ({ page, selfcareLoginPage, selfcareAccountSearchPage, orderManagementPage }) => {
      const logger = new TestLogger('evidence-jepyp-475');
      const db = new DbHelper(logger);
      try { await db.connect(); } catch (e) { blockedIf(true, `database unreachable (VPN?): ${(e as Error).message}`); }
      const seed = new PrepaidSeedHelper(logger);
      const agent = new AgentScreens(page);
      const env = (process.env.TEST_ENV ?? '').replace(/^jasec-?/, '') || 'prod';
      try {
        // No title card (Anh 10-19): the video opens on Core UI while the customer is prepared.
        await (page as any).navigateToHome();
        await caption(page, `JEPYP-475 · JASEC ${env} · Step 1 - Preparing a prepaid customer with a CRC ${CREDIT} top-up...`,
          'Test setup through the Embrix API: account, first service and a CRC 522 top-up.', 1_000);

        // ---- 1. customer with credit on service 1 ----
        const sfx = uniqueRunSuffix();
        const meter1 = assertQaMeter(`M-QABAL-${sfx}1`);
        const meter2 = assertQaMeter(`M-QABAL-${sfx}2`);
        const s = await seed.seed({ meter: meter1, customerId: `E2EBAL-${sfx}`, name: `QA BALANCE TRANSFER video ${sfx}` });
        blockedIf((await orderSettled(db, s.orderId)) !== 'COMPLETED', `${s.accountId}: the first order ${s.orderId} did not complete`);
        await seed.topUp(s.accountId, CREDIT);
        const sub1 = await poll(async () => (await subscriptions(db, s.accountId)).find(x => x.status === 'ACTIVE'),
          x => !!x && Math.abs(x.balance + CREDIT) < 0.01, 90_000, 3_000);
        blockedIf(!sub1, `${s.accountId}: the ${CREDIT} top-up did not land on the subscription`);
        console.log(`  ${s.accountId}: sub 1 ${sub1!.id} (${meter1}) balance ${sub1!.balance}`);

        const services = new ServicesPage(page);
        await agent.openAccount(s.accountId);
        await services.navigateViaSideMenu();
        await mark(page.locator('table').first());
        await caption(page, `Step 1 - Customer ${s.accountId} has one ACTIVE service`,
          `Subscription ${sub1!.id}, meter ${meter1}. A top-up of CRC ${CREDIT} was applied to it.`, 3_000);
        await new BillsPage(page).navigateToBalance();
        const crcRow = () => page.locator('table').filter({ has: page.locator('thead th, thead td', { hasText: 'Currency Id' }) }).first()
          .locator('tbody tr').filter({ hasText: 'CRC' }).first();
        await crcRow().waitFor({ state: 'visible', timeout: 30_000 });
        await mark(crcRow());
        await caption(page, `Step 1 - Balances: CRC -${CREDIT} (credit; JASEC shows credit as a negative amount)`,
          `The credit sits on service 1 (${sub1!.id}).`, 3_000);

        // ---- 2. cancel service 1 - in Core UI, as an agent: Services > select > Place Order CANCEL > reason > CREATE > Submit ----
        const orders = new SuspendResumeOrderPage(page);   // the Cancel Order screen is the same component as Suspend/Resume
        await agent.openAccount(s.accountId);
        await services.navigateViaSideMenu();
        await page.locator(`input[type="checkbox"][name="${sub1!.id}"]`).check({ force: true });
        const cancelLink = page.locator('a[href="/orders/cancel"]').first();
        await mark(cancelLink);
        await caption(page, 'Step 2 - The agent cancels service 1', `Services: select ${sub1!.id}, then Place Order: CANCEL.`, 3_000);
        await cancelLink.click();
        await page.waitForURL(/\/orders\/cancel/, { timeout: 60_000 });
        await orders.chooseSubscriptionReason('NOT_HAPPY');
        await caption(page, 'Step 2 - Cancel Order: Subscription Reason NOT_HAPPY, then CREATE', '', 2_400);
        const cancelOrder = await orders.create();
        blockedIf(!cancelOrder, `Cancel Order CREATE made no order: ${await orders.lastToastText()} ${orders.lastCreateResponse.slice(0, 200)}`);
        await caption(page, `Step 2 - Order ${cancelOrder} created - Submit order`, '', 2_400);
        await orders.submitOrder();
        const cancelStatus = await orderSettled(db, cancelOrder);
        console.log(`  CANCEL ${cancelOrder} (Core UI): ${cancelStatus}`);
        blockedIf(cancelStatus !== 'COMPLETED', `CANCEL ${cancelOrder} ended ${cancelStatus}`);
        await orders.readOrderStatus(cancelOrder);
        await caption(page, `Step 2 - CANCEL order ${cancelOrder}: COMPLETED`, `Service 1 (${sub1!.id}) is closed.`, 3_000);

        // ---- 3. new service on a new meter - Core UI Order Management > Create new order (the TC-01 wizard) ----
        await (page as any).navigateToHome();
        await orderManagementPage.navigateViaNav();
        await orderManagementPage.clickCreateNewOrder();
        await caption(page, 'Step 3 - The agent adds a NEW service on the same account', `Order Management > Create new order > ${s.accountId}`, 2_400);
        await orderManagementPage.searchAccountById(s.accountId, { clearFilters: true });
        await orderManagementPage.clickNextInFirstRow();
        await orderManagementPage.clickNextTop();
        await orderManagementPage.clickNextTop();
        await orderManagementPage.clickNextBelowSubscription();
        await orderManagementPage.clickAddBundle();
        await orderManagementPage.selectBundleById('B-100000-E');
        await orderManagementPage.clickNextBelowSubscription();
        await caption(page, 'Step 3 - Bundle TARIFICACION ENERGIA PREPAGO; the new meter', `Meter ${meter2}`, 2_000);
        await orderManagementPage.addMeterProvisioningData(meter2, 0);
        await orderManagementPage.clickNextTop();
        await orderManagementPage.clickCreate();
        const orderUrl = await orderManagementPage.isProvisioningOrderSuccessfulToastAppear();
        const newOrder = orderUrl.match(/orders\/(ORD-\d+)\//)?.[1] ?? '';
        blockedIf(!newOrder, `Create new order made no order (${orderUrl})`);
        await caption(page, `Step 3 - Order ${newOrder} created - Submit order`, '', 2_400);
        await orderManagementPage.clickRefresh();
        await orderManagementPage.clickSubmitOrder();
        const newStatus = await orderSettled(db, newOrder);
        console.log(`  NEW ${newOrder} (${meter2}, Core UI): ${newStatus}`);
        blockedIf(newStatus !== 'COMPLETED', `NEW order ${newOrder} ended ${newStatus}`);
        await orders.readOrderStatus(newOrder);
        await caption(page, `Step 3 - NEW order ${newOrder}: COMPLETED`, '', 2_400);
        const after = await poll(() => subscriptions(db, s.accountId), a => a.some(x => x.id !== sub1!.id && x.status === 'ACTIVE'), 90_000, 3_000);
        const old = after.find(x => x.id === sub1!.id)!;
        const sub2 = after.find(x => x.id !== sub1!.id && x.status === 'ACTIVE')!;
        console.log(`  after: sub 1 ${old.id} ${old.status} ${old.balance}; sub 2 ${sub2.id} ${sub2.status} ${sub2.balance}`);

        await agent.openAccount(s.accountId);
        await services.navigateViaSideMenu();
        await mark(page.locator('table').first());
        await caption(page, `Step 3 - NEW order ${newOrder} COMPLETED: service 2 (${sub2.id}) is ACTIVE`, `Meter ${meter2}.`, 3_000);

        await new BillsPage(page).navigateToBalance();
        await crcRow().waitFor({ state: 'visible', timeout: 30_000 });
        const ui = Number((await crcRow().locator('td').nth(1).innerText()).replace(/[^0-9.-]/g, ''));
        await mark(crcRow());
        await caption(page, `Step 3 - Balances after the change: CRC ${ui}`, `The ${CREDIT} credit is now on the ACTIVE service 2 (${sub2.id}).`, 3_000);

        await new AccountInfoPage(page).navigateToCustomerActivity();
        await page.waitForURL(/\/activities/, { timeout: 30_000 });
        await page.locator('input[name="startDate"]').fill('2020-01-01');
        await page.locator('input[name="endDate"]').fill('2030-12-31');
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        const actRow = page.locator('table').first().locator('tbody tr').filter({ hasText: /trasladad|BALANCE_MOVED/i }).first();
        const actShown = await actRow.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false);
        const actText = actShown ? (await actRow.innerText()).replace(/\s+/g, ' ').trim() : '';
        console.log(`  UI Customer Activity: ${actText || 'NOT SHOWN'}`);
        if (actShown) await mark(actRow);
        await caption(page, 'Step 3 - Customer Activity records the move', actShown
          ? `Row ${actText.split(' ')[0]}: BALANCE_MOVED_TO_NEW_SUBSCRIPTION on the new service. Opening it (View)...` : 'activity row not shown', 3_000);
        // The grid shows only the API name; the message sits behind View.
        let msgShown = false;
        if (actShown) {
          await actRow.getByText('View', { exact: true }).first().click();
          const msg = page.getByText(/trasladad/i).first();
          msgShown = await msg.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
          console.log(`  UI Customer Activity detail: message ${msgShown ? 'shown' : 'NOT shown'}`);
          if (msgShown) await mark(msg);
          await caption(page, 'Step 3 - The activity detail', msgShown
            ? '"Saldo a favor de CRC 522.00 trasladado del servicio cancelado ... al servicio ..." (credit moved from the cancelled service to the new one)'
            : 'the detail does not show the message text', 4_000);
          await page.keyboard.press('Escape').catch(() => { });
        }

        await attachToAccountInSelfCare({ selfcareLoginPage, selfcareAccountSearchPage }, s.accountId);
        await page.getByText('Billing Data', { exact: true }).first().click();
        await page.getByText('View Balances', { exact: true }).first().click();
        const scRow = page.locator('tr', { has: page.locator('td', { hasText: /^\s*CRC\s*$/ }) }).first();
        await scRow.waitFor({ state: 'visible', timeout: 60_000 });
        const sc = Number((await scRow.locator('td').nth(1).innerText()).replace(/[^0-9.-]/g, ''));
        console.log(`  Self Care View Balances: CRC ${sc}`);
        await mark(scRow);
        await caption(page, `Step 3 - Self Care > Billing Data > View Balances: CRC ${sc}`, 'The customer sees the moved credit on the active service.', 3_400);

        // ---- 4. summary + verdict ----
        const pass = Math.abs(sub2.balance + CREDIT) < 0.01 && Math.abs(old.balance) < 0.01 && Math.abs(ui + CREDIT) < 0.01
          && Math.abs(sc + CREDIT) < 0.01 && actShown;
        await card(page, [
          `Result: ${pass ? 'PASS' : 'FAIL'} - JEPYP-475`,
          `Account ${s.accountId} (${env})`,
          `Before: service 1 ${sub1!.id} = CRC ${sub1!.balance}`,
          `After: cancelled service 1 ${old.id} (${old.status}) = CRC ${old.balance} · new service 2 ${sub2.id} (${sub2.status}) = CRC ${sub2.balance}`,
          `Total unchanged: ${sub1!.balance} → ${Math.round((old.balance + sub2.balance) * 100) / 100} · Core UI Balances ${ui} · Self Care ${sc}`,
          `Orders: CANCEL ${cancelOrder}, NEW ${newOrder} · Customer Activity: ${actShown ? 'move recorded' : 'not shown'}`,
        ], 5_000);

        expect.soft(sub2.balance, 'the new service holds the moved credit').toBeCloseTo(-CREDIT, 2);
        expect.soft(old.balance, 'the cancelled service is left at 0').toBeCloseTo(0, 2);
        expect.soft(ui, 'Core UI Balances shows the credit').toBeCloseTo(-CREDIT, 2);
        expect.soft(sc, 'Self Care View Balances shows the credit').toBeCloseTo(-CREDIT, 2);
        expect.soft(actShown, 'Customer Activity shows the move').toBe(true);
      } finally { await db.disconnect(); }
    });
});
