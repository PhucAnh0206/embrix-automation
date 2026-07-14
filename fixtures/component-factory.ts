import { test as base } from '@playwright/test';
import { Page, Locator } from '@playwright/test';
import { ToastComponent } from '../pages/components/toast.component';
import { ReactSelectComponent } from '../pages/components/react-select.component';

/**
 * ComponentFactory — Provides UI component instances scoped to the current page.
 *
 * Injected via fixtures so tests (and any non-page-object context)
 * can interact with shared UI components without extending BasePage.
 *
 * Usage in a test:
 *   test('...', async ({ toast, reactSelect }) => {
 *     await toast.expectSuccess('Saved');
 *     const dropdown = reactSelect(page.locator('#country'));
 *     await dropdown.select('Costa Rica');
 *   });
 */
export type ComponentFixtures = {
  /** Toastify notification component — scoped to the page root. */
  toast: ToastComponent;

  /**
   * Factory function that creates a ReactSelectComponent scoped to a container.
   * Call it each time you need to interact with a different react-select dropdown.
   */
  reactSelect: (container: Locator) => ReactSelectComponent;
};

export const componentFixture = base.extend<ComponentFixtures>({
  toast: async ({ page }, use) => {
    await use(new ToastComponent(page));
  },

  reactSelect: async ({ page }, use) => {
    const factory = (container: Locator) => new ReactSelectComponent(page, container);
    await use(factory);
  },
});
