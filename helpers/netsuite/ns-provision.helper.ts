/**
 * Provisioning on coopegsbx2 through Order Management (New Order → Reference Order → provisioning data → Create), for
 * contracts with Internet, TV and phone. The provisioning data per service type, as the screen shows it (probed 10-25):
 *   INTERNET  type DEVICE: Provisioning Id = ONT serial, OntModel (flexAttr1) = ONT model
 *   IPTV      type STB:    Provisioning Id + iptvPlatform; the copied data has Provisioning Id = the contract number and
 *                          platform MOTV (UPDATE_PROVISIONING_IDENTIFIER on 244700): MOTV logs the viewer in with it
 *   VOIP      type DID:    Provisioning Id = the phone number from the PortaOne number inventory
 * The NOKIA / MOTV / PortaOne steps run for real once the order is created, so the safety checks below come first.
 * tests/dev/ns-provision.spec.ts keeps its own (Internet-only) copy of the screen steps.
 */
import * as fs from 'fs';
import { Client } from 'pg';
import { Page } from '@playwright/test';
import { suiteDir } from './suite-dir';

const PG_CFG = require('path').join(suiteDir(), 'tools', '.pg-coopegsbx-dev.json');
/** Kiet's ONT on the CoopeG Sandbox: never used from here. */
export const KIET_ONT = 'ALCLB3A97FBA';

export interface ProvRow { serviceType: 'INTERNET' | 'IPTV' | 'VOIP'; id: string; model?: string; platform?: string }

/** Where this environment still uses the ONT (read only); an empty list means free here (NOKIA itself is not visible). */
export async function ontInUse(ont: string): Promise<string[]> {
  const c = new Client({ ...JSON.parse(fs.readFileSync(PG_CFG, 'utf8')), port: 5432, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
    options: '-c default_transaction_read_only=on -c statement_timeout=60000' });
  await c.connect();
  try {
    const su = (await c.query(`select id, accountid, status from core_engine.service_unit where provisioningid = $1 and status <> 'CLOSED'`, [ont])).rows;
    const sp = (await c.query(`select provisioningid from core_engine.service_provision where provisioningid = $1 and enddate is null`, [ont])).rows;
    return [...su.map(r => `service ${r.id} (${r.accountid}) ${r.status}`), ...sp.map(() => 'open service provision')];
  } finally { await c.end(); }
}

/**
 * The provisioning order of a new contract, as an agent creates it in Order Management. Returns the creation toast.
 * om: the OrderManagementPage fixture.
 */
export async function provisioningOrder(page: Page, om: any, account: string, order: string, rows: ProvRow[]): Promise<string> {
  await (page as any).navigateToHome();
  await om.navigateViaNav();
  await om.clickCreateNewOrder();
  await om.searchAccountById(account, { clearFilters: true });
  await om.clickNextInFirstRow();
  await om.clickReferenceOrder();
  await om.searchByOrderId(order);
  // The visible box is drawn by CSS on a zero-size label, so fire the click on the input itself (ns-90 probe).
  await page.getByRole('dialog').locator('tr', { hasText: order }).first().getByRole('checkbox').dispatchEvent('click');
  await om.clickSelectButton();
  for (const r of rows) {
    // One table per service type ("Service Type: VOIP / IPTV / INTERNET"), each row with its own View.
    await page.getByText(`Service Type: ${r.serviceType}`, { exact: true }).locator('xpath=following::button[normalize-space()="View"][1]').click();
    const dlg = page.getByRole('dialog').first();
    await dlg.waitFor({ state: 'visible', timeout: 30_000 });
    await dlg.getByRole('button', { name: '+Add' }).click();
    await dlg.locator('input[name="provisioningId"]').last().fill(r.id);
    if (r.model) await dlg.locator('input[name="flexAttr1"]').last().fill(r.model);
    if (r.platform) {
      // The iptvPlatform cell: a text input on some builds, a select on others.
      const input = dlg.locator('tbody tr').last().locator('input:not([name="provisioningId"])').first();
      if (await input.count()) await input.fill(r.platform);
      else { await dlg.locator('tbody tr').last().locator('[class*=control], select').first().click(); await page.getByText(r.platform, { exact: true }).last().click(); }
    }
    await om.clickSubmitButton();
  }
  await om.clickNextAboveSubscription();
  await om.clickCreate();
  // The page object also waits for the redirect to the new order's page, which can take longer than its 30 s
  // (10-26: toast shown, redirect late). The toast is what confirms the order; the redirect is not needed here.
  return om.isProvisioningOrderSuccessfulToastAppear().catch((e: Error) => {
    if (/waitForURL/.test(e.message)) return 'Create Order successfully (redirect to the order page was late)';
    throw e;
  });
}
