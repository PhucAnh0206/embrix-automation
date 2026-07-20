import { Page, expect } from '@playwright/test';
import { OrderManagementPage } from './order-management.page';
import { SHORT_WAIT, MEDIUM_WAIT, LONG_WAIT, EXTRA_LONG_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';
import { ScreenshotHelper } from '../../../helpers/screenshot.helper';

/**
 * JASEC-specific Order Management flows built on top of the team's
 * OrderManagementPage. Adds JASEC's prepaid-order wizard sequence
 * (bundle picker, meter provisioning, order-detail refresh/submit).
 *
 * Keep team's OrderManagementPage untouched — it stays the canonical
 * class for non-JASEC suites.
 */
export class JasecOrderManagementPage extends OrderManagementPage {
  private readonly jasecServiceTable: TableComponent;

  constructor(page: Page) {
    super(page);
    this.jasecServiceTable = new TableComponent(
      page,
      this.page.locator('//div[not(@id="scrollableDiv")]/table'),
    );
  }

  // ── Locators (JASEC-specific) ───────────────────────────────────────
  private get createNewOrderLink() { return this.page.getByRole('link', { name: 'Create new order' }); }
  private get accountIdSearchInput() { return this.page.locator('input[name="accountId"]'); }
  private get primarySubPanel() { return this.page.locator('//span[@class="panel__title"][contains(text(),"Subscription: Primary")]'); }
  private get viewProvisioningModal() { return this.page.locator('//h5[@class="modal-title"][text()="View Provisioning Data"]/../..'); }
  private get viewProvisioningModalAddBtn() { return this.viewProvisioningModal.getByRole('button', { name: /\+?\s*Add/i }); }
  private get viewProvisioningModalProvisioningIDInput() { return this.viewProvisioningModal.locator("//input[@name='provisioningId']").last(); }
  private get viewProvisioningModalMeterReadingInput() { return this.viewProvisioningModal.locator("//input[@name='flexAttr1']").last(); }
  private get viewProvisioningModalSubmitButton() { return this.viewProvisioningModal.getByRole('button', { name: 'Submit' }); }
  private get submitOrderButton() { return this.page.getByRole('button', { name: /^\s*(Submit\s*order|Enviar\s*orden)\s*$/i }).first(); }
  private get addBundleButton() { return this.page.getByRole('button', { name: /ADD BUNDLE/i }); }
  private get nextButtonTop() { return this.page.getByRole('button', { name: /^NEXT$/i }).first(); }
  private get nextButtonBottom() { return this.page.getByRole('button', { name: /^NEXT$/i }).last(); }

  // ── Override: clickCreateNewOrder ───────────────────────────────────
  // Team's default clicks the CTA without first dismissing the hover-opened
  // nav dropdown. On JASEC the dropdown intercepts the click and the action
  // times out; escape + dismissDropdowns() clears the overlay first.
  async clickCreateNewOrder(): Promise<void> {
    await this.createNewOrderLink.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.page.keyboard.press('Escape').catch(() => { });
    await this.dismissDropdowns();
    await this.createNewOrderLink.scrollIntoViewIfNeeded().catch(() => { });
    await this.createNewOrderLink.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
    await this.accountIdSearchInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
  }

  // ── Wizard NEXT buttons ─────────────────────────────────────────────

  /** Top NEXT button (Select Account → Order Data → Add Subscription → Subscription Data → Create/Cancel). */
  async clickNextTop(): Promise<void> {
    await this.nextButtonTop.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.nextButtonTop.click();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
    await this.page.waitForLoadingToDisappear();
  }

  /** Bottom NEXT below "Subscription: Primary" (Subscription Terms → Purchase Options → Override Options). */
  async clickNextBelowSubscription(): Promise<void> {
    await this.nextButtonBottom.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.nextButtonBottom.click();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
    await this.page.waitForLoadingToDisappear();
  }

  // ── Bundle picker (Purchase Options → ADD BUNDLE) ───────────────────

  async clickAddBundle(): Promise<void> {
    await this.addBundleButton.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.addBundleButton.click();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
  }

  /**
   * Select a bundle by ID inside the "Choose Bundle" modal:
   * filter row (Id) → SEARCH → tick row radio → footer Select.
   */
  async selectBundleById(bundleId: string): Promise<void> {
    const modal = this.page.locator(
      "//div[contains(@class,'modal') and .//h6[normalize-space()='Choose Bundle']]"
    ).first();
    await modal.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });

    const idInput = modal.locator("//input[@name='id']").first();
    if (await idInput.isVisible().catch(() => false)) {
      await idInput.fill(bundleId);
      await modal.getByRole('button', { name: /^SEARCH$/i }).first().click();
      await this.page.waitForLoadingToDisappear();
      await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
    }

    const row = modal.locator(`//tr[./td[normalize-space()=${qstr(bundleId)}]]`).first();
    await row.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    const radio = row.locator('input[type="radio"]').first();
    if (await radio.isVisible().catch(() => false)) {
      await radio.check({ force: true }).catch(async () => { await radio.click(); });
    } else {
      await row.locator('td').first().click();
    }

    await modal.getByRole('button', { name: /^Select$/i }).first().click();
    await modal.waitFor({ state: 'hidden', timeout: MEDIUM_WAIT }).catch(() => { });
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
  }

  // ── Meter modal (Override Options → View → +Add → Submit) ───────────

  async addMeterProvisioningData(provisioningId: string, lecturaInicialKwh: string | number): Promise<void> {
    await this.primarySubPanel.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.jasecServiceTable.clickCellLink(0, 'View');
    await this.page.waitForLoadingToDisappear();
    await this.viewProvisioningModal.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });

    await this.viewProvisioningModalAddBtn.click();
    await expect(this.viewProvisioningModalProvisioningIDInput).toHaveValue('');

    await this.viewProvisioningModalProvisioningIDInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.viewProvisioningModalProvisioningIDInput.fill(provisioningId);

    await this.viewProvisioningModalMeterReadingInput.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.viewProvisioningModalMeterReadingInput.fill(String(lecturaInicialKwh));

    await this.viewProvisioningModalSubmitButton.click();
    await this.page.waitForLoadingToDisappear();
    await expect(this.viewProvisioningModal).not.toBeVisible({ timeout: MEDIUM_WAIT });
  }

  // ── SUBMIT / REFRESH (post-CREATE) ──────────────────────────────────

  async clickSubmitOrder(): Promise<void> {
    await this.submitOrderButton.scrollIntoViewIfNeeded().catch(() => { });
    await this.submitOrderButton.click();
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
  }

  /**
   * Refresh the order detail page by reloading the URL. Reloading (rather
   * than clicking the in-page REFRESH button) avoids racing with the
   * button's enable → disable transition after order creation.
   */
  async clickRefresh(): Promise<void> {
    const url = this.page.url();
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadingToDisappear();
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { });
  }

  /**
   * Assert the order reached COMPLETED status and the expected bundle is
   * attached. Status field renders either as a disabled <input> or a
   * react-select; we poll both shapes.
   */
  async verifyOrderCompletedWithBundle(expectedBundleName: string): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const groups = Array.from(document.querySelectorAll('div')).filter((d) => {
          const span = d.querySelector(':scope > span');
          return (
            d.className.includes('form-group') &&
            span !== null &&
            (span.textContent || '').trim().toLowerCase() === 'status'
          );
        });
        for (const g of groups) {
          const input = g.querySelector('input') as HTMLInputElement | null;
          if (input && /^COMPLETED$/i.test(input.value || '')) return true;
          const sv = g.querySelector('.custom-react-select__single-value');
          if (sv && /^COMPLETED$/i.test((sv.textContent || '').trim())) return true;
        }
        return false;
      },
      undefined,
      { timeout: 2 * EXTRA_LONG_WAIT },
    );

    const bundleText = this.page.getByText(expectedBundleName, { exact: false }).first();
    await expect(bundleText).toBeVisible({ timeout: LONG_WAIT });
  }
}

/** XPath-safe string literal — handles single/double quotes. */
function qstr(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.split("'").join(`',"'",'`)}')`;
}
