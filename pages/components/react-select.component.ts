import { Page, Locator } from '@playwright/test';
import { SHORT_WAIT, MEDIUM_WAIT } from '../../helpers/timeouts.helper';

/**
 * ReactSelectComponent — Encapsulates interactions with custom React-Select dropdowns.
 *
 * Each instance is scoped to a specific container Locator, so multiple
 * react-select dropdowns on the same page can be controlled independently.
 *
 * Usage from a Page Object:
 *   const countrySelect = this.reactSelect(this.page.locator('#country-field'));
 *   await countrySelect.select('Costa Rica');
 *   await countrySelect.typeAndSelect('Cost', 'Costa Rica');
 */
export class ReactSelectComponent {
  /**
   * @param page - Playwright's Page instance.
   * @param container - Locator targeting the root container of the react-select component.
   */
  constructor(
    private readonly page: Page,
    private readonly container: Locator,
  ) {}

  // ── Locators (lazy, scoped to container) ────────────────────────────

  /** The clickable control element inside the container. */
  private get control() {
    return this.container
      .locator('.custom-react-select__control, [class*="react-select__control"]')
      .first();
  }

  /**
   * The dropdown menu — rendered at page root level (portalled),
   * so we scope to the page and take the last visible one.
   */
  private get menu() {
    return this.page
      .locator('.custom-react-select__menu, [class*="react-select__menu"]')
      .last();
  }

  // ── Actions ─────────────────────────────────────────────────────────

  /**
   * Open the dropdown and click an option by its visible label text.
   * @param optionText Exact or partial text of the option to select.
   */
  async select(optionText: string): Promise<void> {
    await this.control.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.control.click();

    await this.menu.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    await this.menu
      .getByText(new RegExp(this.escapeRegex(optionText), 'i'))
      .click();
    await this.menu.waitFor({ state: 'hidden', timeout: SHORT_WAIT });
  }

  /**
   * Type into the react-select input to filter options, then click the match.
   * Useful when the option list is long (e.g., country, currency).
   * @param searchText Text to type into the search input.
   * @param optionText Text of the option to click (defaults to searchText).
   */
  async typeAndSelect(searchText: string, optionText?: string): Promise<void> {
    await this.control.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.control.click();

    const input = this.control.locator('input').first();
    await input.fill(searchText);

    await this.menu.waitFor({ state: 'visible', timeout: SHORT_WAIT });
    const target = optionText ?? searchText;
    await this.menu
      .getByText(new RegExp(this.escapeRegex(target), 'i'))
      .first()
      .click();
    await this.menu.waitFor({ state: 'hidden', timeout: SHORT_WAIT });
  }

  // ── Utilities ───────────────────────────────────────────────────────

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
