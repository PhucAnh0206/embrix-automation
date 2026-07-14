import { test as base } from '@playwright/test';
import { TaskManagementPage } from '../../../pages/operations-hub/task-management/taskManagement.page';
/**
 * Type definition for Task management page fixtures.
 */
export type TaskFixtures = {
  /** TaskManagementPage Page Object instance. */
  taskManagementPage: TaskManagementPage;
};

/**
 * Playwright fixture extension for TaskManagementPage.
 */
export const taskFixtures = base.extend<TaskFixtures>({
  taskManagementPage: async ({ page }, use) => {
    const taskManagementPage = new TaskManagementPage(page);
    await use(taskManagementPage);
  },
});
