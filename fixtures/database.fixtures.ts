// fixtures/database.fixtures.ts
import { test as base } from '@playwright/test';
import { DatabaseHelper } from '../helpers/database.helper';

export type DatabaseFixtures = {
    databaseHelper: DatabaseHelper;
};

export const databaseFixture = base.extend<DatabaseFixtures>({
    databaseHelper: async ({ }, use) => {
        const databaseHelper = new DatabaseHelper();
        await use(databaseHelper);
    },
});