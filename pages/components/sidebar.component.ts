import { Page, Locator } from '@playwright/test';
import { MEDIUM_WAIT, SHORT_WAIT } from '../../helpers/timeouts.helper';

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
 * Usage:
 *   const sidebar = new SidebarComponent(page);
 *   await sidebar.navigateTo('Jobs Management', 'DAILY');           // 2 levels
 *   await sidebar.navigateTo('Subscription Data', 'Assets', 'Services');  // 3 levels
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

  /** Locates the top-level submenu container <div> inside a category <li>. */
  private submenuContainer(categoryName: string): Locator {
    return this.categoryItem(categoryName).locator('> div').first();
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

  // ── State checks ──────────────────────────────────────────────────────

  /** Check if a top-level category is currently expanded (its submenu is visible). */
  private async isCategoryExpanded(categoryName: string): Promise<boolean> {
    const container = this.submenuContainer(categoryName);
    const hasDisplayNone = await container.evaluate(
      (el) => el.classList.contains('display-none')
    ).catch(() => true);
    return !hasDisplayNone;
  }

  // ── Actions ───────────────────────────────────────────────────────────

  /**
   * Expand a sidebar category if it is not already expanded.
   * Clicks the category header to toggle its submenu open.
   */
  async expandCategory(categoryName: string): Promise<void> {
    const isExpanded = await this.isCategoryExpanded(categoryName);
    if (!isExpanded) {
      const header = this.categoryHeader(categoryName);
      await header.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
      await header.click();
      // Wait for the submenu to become visible
      await this.submenuContainer(categoryName).waitFor({ state: 'visible', timeout: SHORT_WAIT }).catch(() => { });
    }
  }

  /**
   * Click a menu item (Level 2 or 3) inside a category.
   * Waits for the link to be visible and clicks it.
   */
  async clickMenuItem(categoryName: string, itemName: string): Promise<void> {
    const link = this.menuItemLink(categoryName, itemName);
    await link.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await link.click();
    await this.page.waitForLoadState('networkidle').catch(() => { });
  }

  /**
   * Navigate to a screen via the sidebar (supports up to 3 levels).
   *
   * @param category  - Level 1: The top-level category name (e.g. "Jobs Management", "Subscription Data")
   * @param level2    - Level 2: The sub-menu item (e.g. "DAILY", "Assets")
   * @param level3    - Level 3: Optional third-level item (e.g. "Services" under "Assets")
   * @returns The current page URL after navigation.
   */
  async navigateTo(category: string, level2: string, level3?: string): Promise<string> {
    // If level3 is specified, check if it's already visible → click directly
    if (level3) {
      const level3Link = this.page.locator(`a:has(span.right-nav-text:text-is("${level3}"))`).first();
      if (await level3Link.isVisible().catch(() => false)) {
        await level3Link.click();
        await this.page.waitForLoadState('networkidle')
        await this.page.waitForLoadingToDisappear()
        return this.page.url();
      }
    }

    // Check if level2 is already visible
    const level2Link = this.page.locator(`a:has(span.right-nav-text:text-is("${level2}"))`).first();
    const isLevel2Visible = await level2Link.isVisible()

    if (!isLevel2Visible) {
      // Expand the level-1 category
      await this.expandCategory(category);
      await this.page.waitForLoadingToDisappear()
    }

    // Click level 2 (this will click it directly, or expand it if it's a sub-category)
    await this.clickMenuItem(category, level2);
    await this.page.waitForLoadingToDisappear()

    // If level 3 is specified, click it (level 2 click should have made it visible)
    if (level3) {
      await this.clickMenuItem(category, level3);
      await this.page.waitForLoadingToDisappear()
    }

    return this.page.url();
  }
}
