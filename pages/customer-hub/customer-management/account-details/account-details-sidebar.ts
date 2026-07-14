import { Page } from '@playwright/test';
import { SidebarComponent } from '../../../components/sidebar.component';

/**
 * AccountDetailsSidebar — Thin wrapper around SidebarComponent
 * scoped to the Customer Account Details view.
 *
 * Maintains backward compatibility with existing page objects
 * (BillsPage, ServicesPage, AccountInfoPage) that use `navigateToSubScreen`.
 *
 * @deprecated Prefer injecting SidebarComponent directly for new pages.
 */
export class AccountDetailsSidebar {
  private readonly sidebar: SidebarComponent;

  constructor(page: Page) {
    this.sidebar = new SidebarComponent(page);
  }

  /**
   * Navigate to a subscreen via the sidebar (supports up to 3 levels).
   * Delegates to SidebarComponent.navigateTo().
   */
  async navigateToSubScreen(category: string, level_2: string, level_3?: string): Promise<string> {
    return this.sidebar.navigateTo(category, level_2, level_3);
  }
}
