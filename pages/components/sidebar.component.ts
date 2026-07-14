import { Page, Locator } from '@playwright/test';
import { MEDIUM_WAIT } from '../../helpers/timeouts.helper';

/**
 * SidebarComponent — Reusable left sidebar navigation component.
 *
 * Works with the shared sidebar pattern used across the Embrix application
 * (e.g. Account Details, Jobs Management, etc.).
 *
 * DOM Structure:
 * ```html
 * <li class="item-nav">
 *   <a class="right-nav-text nav-main cursor ..." aria-expanded="true|false">
 *     <span class="right-nav-text">Category Name</span>
 *   </a>
 *   <div class="[display-none]">  <!-- submenu container -->
 *     <div>
 *       <a class="[active]" href="/path">
 *         <span class="right-nav-text">Menu Item</span>
 *       </a>
 *     </div>
 *   </div>
 * </li>
 * ```
 *
 * Navigation flow (top-down):
 *   1. If Level 2 is not visible → click Level 1 header to expand category
 *   2. If Level 3 is needed and not visible → click Level 2 to expand sub-menu
 *   3. Click the final target (Level 2 or Level 3)
 *
 * Usage:
 *   const sidebar = new SidebarComponent(page);
 *   await sidebar.navigateTo('Jobs Management', 'DAILY');                    // 2 levels
 *   await sidebar.navigateTo('Subscription Data', 'Assets', 'Services');     // 3 levels
 */
export class SidebarComponent {
  constructor(private readonly page: Page) { }

  // ── Locator helpers ───────────────────────────────────────────────────

  /** Locates the sidebar category (level-1) <li> by its label text. */
  private categoryItem(name: string): Locator {
    return this.page.locator(
      `li.item-nav:has(> a span.right-nav-text:text-is("${name}"))`
    );
  }

  /** Locates the category header <a> (the clickable element to expand/collapse). */
  private categoryHeader(name: string): Locator {
    return this.categoryItem(name).locator('> a').first();
  }

  /**
   * Locates a menu item link (Level 2 or Level 3) inside a top-level category.
   * Matches by the visible text of the <span class="right-nav-text"> inside the <a>.
   */
  private menuItemLink(categoryName: string, itemName: string): Locator {
    return this.categoryItem(categoryName).locator(
      `a:has(span.right-nav-text:text-is("${itemName}"))`
    ).first();
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Navigate to a screen via the sidebar (supports up to 3 levels).
   *
   * Uses actual element visibility as the source of truth — never relies on
   * `aria-expanded` or DOM class checks, which can be stale in SPA routing.
   *
   * @param category  - Level 1: The top-level category (e.g. "Subscription Data")
   * @param level2    - Level 2: The sub-menu item (e.g. "Assets")
   * @param level3    - Level 3: Optional third-level item (e.g. "Services")
   * @returns The current page URL after navigation.
   */
  async navigateTo(category: string, level2: string, level3?: string): Promise<string> {
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForLoadingToDisappear().catch(() => {});

    // Step 1: Ensure Level 2 is visible (expand Level 1 category if needed)
    const level2Link = this.menuItemLink(category, level2);

    if (!(await level2Link.isVisible().catch(() => false))) {
      const header = this.categoryHeader(category);
      await header.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
      await header.click();
      await this.page.waitForLoadingToDisappear().catch(() => {});
      await level2Link.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    }

    // Step 2: If no Level 3 → click Level 2 directly
    if (!level3) {
      await level2Link.click();
      await this.page.waitForLoadState('networkidle').catch(() => {});
      await this.page.waitForLoadingToDisappear();
      return this.page.url();
    }

    // Step 3: Ensure Level 3 is visible (expand Level 2 sub-menu if needed)
    const level3Link = this.menuItemLink(category, level3);

    if (!(await level3Link.isVisible().catch(() => false))) {
      await level2Link.click();

      // Wait for Level 3 to appear; if stale SPA state caused Level 2 to
      // collapse instead of expand, retry once.
      const appeared = await level3Link
        .waitFor({ state: 'visible', timeout: MEDIUM_WAIT })
        .then(() => true)
        .catch(() => false);

      if (!appeared) {
        await level2Link.click();
        await level3Link.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
      }
    }

    // Step 4: Click Level 3
    await level3Link.click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForLoadingToDisappear();
    return this.page.url();
  }
}
