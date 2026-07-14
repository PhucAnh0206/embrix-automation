import { test as base } from '@playwright/test';
import { ServerHelper } from '../../helpers/server-api.helper';

/**
 * Type definition for server API fixtures.
 */
export type ServerFixtures = {
  /** ServerHelper instance for executing server-level configurations. */
  serverHelper: ServerHelper;
};

/**
 * Playwright fixture extension for ServerHelper.
 */
export const serverFixture = base.extend<ServerFixtures>({
  serverHelper: async ({ request }, use) => {
    const serverHelper = new ServerHelper(request);
    await use(serverHelper);
  },
});
