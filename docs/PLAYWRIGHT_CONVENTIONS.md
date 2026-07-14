# Playwright Test Automation Conventions & Guidelines

This document outlines the coding standards, patterns, and conventions for **Page Objects**, **Specs (Tests)**, **Fixtures**, and **Helpers** in the **Embrix Auto** project. All developers, QA engineers, and AI coding assistants must adhere to these guidelines when modifying the repository or writing new automation flows.

---

## 1. Folder Structure

The project directory is structured logically. Match the location of new files according to their type:

```
EmbrixAuto/
├── docs/                        # Project documentation (including this file)
├── fixtures/                    # Custom Playwright fixtures (page-factory.ts)
├── helpers/                     # API helpers, logger, timeouts helper, screenshot helper
│   └── db/                      # Database helpers encapsulating SQL (e.g. JobScheduleDbHelper)
├── pages/                       # Page Object Model (POM) classes
│   ├── components/              # Shared UI component wrappers (Table, Toast, ReactSelect, Sidebar)
│   ├── customer-hub/            # POM sub-directories mapped to Customer Hub modules
│   └── operations-hub/          # POM sub-directories mapped to Operations Hub modules
└── tests/                       # Spec (Test) files
    ├── regression/              # Regression test suites (using saved auth state)
    └── smoke/                   # Smoke tests (no auth dependency)
```

---

## 2. Naming Conventions

* **File Names**: Use kebab-case. 
  * POM files: `*.page.ts` (e.g., `customer-management.page.ts`)
  * Spec files: `*.spec.ts` or `*.setup.ts` (e.g., `auth.setup.ts`, `ts-01.spec.ts`)
  * Helper files: `*.helper.ts` (e.g., `account-order-api.helper.ts`)
* **Class Names**: Use PascalCase.
  * POM: `CustomerManagementPage` (must end with `Page`)
  * Helper: `ServerHelper` (must end with `Helper`)
  * Component: `TableComponent`, `SidebarComponent` (must end with `Component`)
  * DB Helper: `JobScheduleDbHelper` (must end with `DbHelper`)
* **Method Names**: Use camelCase starting with action verbs (e.g., `click`, `fill`, `select`, `navigate`, `get`, `verify`).
* **Locators / Getters**: Use camelCase matching the visual label of the element on screen.

---

## 3. Page Object Model (POM) Guidelines

All Page Object classes must extend `BasePage` and encapsulate selectors and interactions.

### POM Architecture & Rules
1. **Inherit from `BasePage`**: It provides shared utilities such as `navigate()`, `waitForLoadingToDisappear()`, and navigation hovers.
2. **Private Locator Getters**: Do not expose raw selectors or locators as public variables. Define them as `private get` properties. This defers evaluation and enforces encapsulation.
3. **Assertions**: Keep assertions out of action methods. Store them in separate spec files, or put them in dedicated POM verification methods prefixed with `verify*` or `assert*`.
4. **Use Shared Components**: Do not duplicate selectors for standard UI widgets. Use `TableComponent`, `ToastComponent`, `ReactSelectComponent`, and `SidebarComponent`.
5. **Handle Loading States**: Call `await this.page.waitForLoadingToDisappear();` after actions that trigger backend APIs or page-load events.

### POM Code Example
```typescript
import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from '../../base.page';
import { SHORT_WAIT, MEDIUM_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';

/**
 * FeatureNamePage — Represents the Feature Name screen in the application.
 */
export class FeatureNamePage extends BasePage {
  readonly mainTable: TableComponent;

  constructor(page: Page) {
    super(page);
    this.mainTable = new TableComponent(page, this.page.locator('table').first());
  }

  // ── DOM Elements ────────────────────────────────────────────────────────

  private get searchInput() { return this.page.locator('input[name="search"]') }
  private get submitButton() { return this.page.getByRole('button', { name: 'Submit' }) }

  // ── Public Action Methods ────────────────────────────────────────────────

  async searchItem(keyword: string): Promise<void> {
    await this.searchInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.searchInput.fill(keyword);
    await this.submitButton.click();
    await this.page.waitForLoadingToDisappear();
  }
}
```

---

## 4. Spec Files (Tests) Conventions

Spec files contain the test scenarios and assertions.

### Spec Coding Rules
1. **Import from Page-Factory**: Always import `test` and `expect` from the local custom page-factory, **never** directly from `@playwright/test`.
   * *Correct*: `import { test, expect } from '../../../fixtures/page-factory';`
   * *Incorrect*: `import { test, expect } from '@playwright/test';`
2. **Serial Execution**: Use `test.describe.serial` for flow-based regression tests where test cases are dependent on data created by previous cases.
3. **Suite State Management**: Define a local `SuiteState` interface and local mutable state object (`const state: Partial<SuiteState> = {}`) to share variables between serial tests.
4. **Context Persistence**: Use `updateTestContext()` to save critical generated IDs (e.g. `accountId`, `orderId`) to the filesystem (`playwright/.auth/test-context.json`). **Never** call `saveTestContext()` from mid-suite code — it overwrites the entire file and destroys data from earlier tests. Always use `updateTestContext()` which merges partial data.
5. **Logging**: Use the `testLogger` fixture for logging actions, API payloads, and custom response details instead of standard `console.log`.

### Spec Code Example
```typescript
import { test, expect } from '../../../fixtures/page-factory';
import { updateTestContext } from '../../../helpers/test-context.helper';

interface SuiteState {
  accountId: string;
}

const state: Partial<SuiteState> = {};

test.describe.serial('REGRESSION: Order Processing Flow', () => {

  test('TC-01: Residential Account Creation', async ({
    page, accountOrderApiHelper, testLogger, customerManagementPage
  }) => {
    const { accountId } = await accountOrderApiHelper.createAccountAndOrder();
    state.accountId = accountId;
    testLogger.data('Created Account ID', accountId);

    await page.navigateToHome();
    await customerManagementPage.navigateViaNav();
    await customerManagementPage.searchByAccountId(accountId);

    const activeAcct = await customerManagementPage.getFirstRowCellValue('ACCT No');
    expect(activeAcct).toBe(accountId);

    updateTestContext({ accountId });
  });
});
```

---

## 5. Fixtures Conventions

Fixtures handle dependency injection and instantiate page/helper objects automatically.

1. **Centralized Factory**: Manage all test fixtures in `fixtures/page-factory.ts`.
2. **Context Extension**: Use `base.extend<AllFixtures>({ ... })` so all Page Objects and Helpers share the same page/request context.
3. **Custom Page Extensions (Monkey Patching)**: Define globally available utility wrappers by extending Playwright's native `Page` interface in the factory file (e.g., `page.navigateToHome()` and `page.waitForLoadingToDisappear()`). This allows clean, globally available utilities across all standalone components and page objects without tight inheritance coupling or duplicate code.
4. **State Persistence / Context Fixture**: Use `testContext` fixture (which exposes `load()`, `update()`, and `save()`) to manage state persistence seamlessly without manually loading files in specs.

---

## 6. Helpers Conventions

Helpers coordinate API calls, database setups, and utility functions.

1. **Class Structure**: Helpers must be written as regular classes. Do not use Playwright runner imports directly inside helper code.
2. **Constructor Injection**: Inject Playwright's `APIRequestContext` and the custom `TestLogger` into the helper via constructor parameters.
3. **Response Assertions**: Always assert response codes (`expect(response.status()).toBe(200)`) and log failure text content when APIs reject.

### Helper Code Example
```typescript
import { APIRequestContext, expect } from '@playwright/test';
import { TestLogger } from './test-logger';

export class APIHelper {
  constructor(
    private readonly request: APIRequestContext,
    private readonly logger?: TestLogger
  ) {}

  async submitData(endpoint: string, payload: any): Promise<void> {
    this.logger?.api('POST', endpoint);
    const response = await this.request.post(endpoint, { data: payload });
    
    if (!response.ok()) {
      const errBody = await response.text();
      this.logger?.error(`API Failure on ${endpoint}`, errBody);
      throw new Error(`API returned status ${response.status()}`);
    }
  }
}
```

---

## 7. Standard Timeouts & Anti-Flakiness Rules

1. **Absolutely No Indiscriminate Fixed Waits (No Hardcoded/Fixed Waits)**:
   - Avoid using `page.waitForTimeout()` indiscriminately. Instead, always wait dynamically for the state of the subsequent element to appear (or disappear) using `.waitFor({ state: 'visible' / 'hidden' })` or `page.waitForURL()`.
   - **Rules for AI Assistants**: If during development you cannot identify the subsequent element to wait for, or if you are unsure whether waiting is necessary, **you must pause and ask the developer/user for clarification** rather than arbitrarily adding fixed timeouts.
2. **Use Standard Timeouts**:
   Avoid using random millisecond values. When configuring timeouts for `.waitFor()`, use the standard constants imported from `timeouts.helper.ts`:
   - `SHORT_WAIT`: 1s - 3s (element stability, micro-animations)
   - `MEDIUM_WAIT`: 5s - 10s (standard locator waits, search results)
   - `LONG_WAIT`: 10s - 20s (API page redirects, large modal transitions)
   - `EXTRA_LONG_WAIT`: 30s - 60s (heavy background jobs, provisioning syncs)

---

## 8. Database Helper Conventions

To maintain a clean Page Object Model (POM) and clean separation of concerns, follow these rules when interacting with databases:

1. **Separation of Concerns**: Never execute SQL queries directly inside Page Objects or Spec files. All SQL operations must be abstracted into dedicated database helpers (e.g., `helpers/db/job-schedule.db.ts`).
2. **Generic vs. Business Helpers**:
   - `helpers/database.helper.ts` is a generic PG client. Do not add feature-specific queries here.
   - Specific helper classes (e.g., `JobScheduleDbHelper`) should import `DatabaseHelper` and encapsulate business-specific queries.
3. **Query Encapsulation**: Store SQL queries as clear uppercase strings or parameter-based template literals at the top of the helper methods to separate data logic from Javascript execution logic.
4. **Statement Timeout**: Always configure `statement_timeout` on the PG client (using `EXTRA_LONG_WAIT` from `timeouts.helper.ts`) to avoid tests hanging indefinitely on slow queries or network partitions.
5. **No Blind Empty Checks**: When querying the database to check if record cleanup is needed, avoid testing for `result.length > 0` directly without proper awaiting, or assuming that an empty array means no record exists before the query completes. Handle timeout errors using `try/catch` to differentiate between a slow query and a genuinely empty database response.

---

## 9. Sidebar Component Convention

The `SidebarComponent` (`pages/components/sidebar.component.ts`) is a reusable left-sidebar navigation component that works across all application modules (Account Details, Jobs Management, etc.).

### Usage Rules
1. **Use SidebarComponent for new pages**: Any new page that has left sidebar navigation should compose `SidebarComponent` as a member, not create its own sidebar logic.
2. **Legacy wrapper**: `AccountDetailsSidebar` is a thin wrapper around `SidebarComponent` for backward compatibility. Do not duplicate this pattern for new modules.
3. **navigateTo() supports 2-3 levels**: `sidebar.navigateTo('Category', 'Level2')` or `sidebar.navigateTo('Category', 'Level2', 'Level3')`.
4. **Handles already-expanded menus**: The component checks whether the submenu is already expanded before clicking, avoiding unnecessary toggle actions.

### Example
```typescript
import { SidebarComponent } from '../../components/sidebar.component';

export class MyNewPage extends BasePage {
  readonly sidebar: SidebarComponent;

  constructor(page: Page) {
    super(page);
    this.sidebar = new SidebarComponent(page);
  }

  async navigateViaSidebar(): Promise<string> {
    return this.sidebar.navigateTo('Jobs Management', 'DAILY');
  }
}
```
