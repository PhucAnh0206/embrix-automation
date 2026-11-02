import { test as base } from '@playwright/test';
import { TestLogger } from '../helpers/test-logger';

/**
 * Type definition for logger fixtures.
 */
export type LoggerFixtures = {
  /** TestLogger instance scoped to each test run. */
  testLogger: TestLogger;
};

/**
 * Playwright fixture extension for TestLogger.
 * Instantiates the logger, flushes it on test completion, and attaches the log file to the HTML report.
 */
export const loggerFixture = base.extend<LoggerFixtures>({
  testLogger: async ({}, use, testInfo) => {
    const logger = new TestLogger(testInfo.title);
    await use(logger);

    // Flush the log file after the test completes
    logger.flush();

    // Attach the log file to the Playwright HTML report
    await testInfo.attach('test-log', {
      path: logger.getFilePath(),
      contentType: 'text/plain',
    }).catch(() => {
      // Silently ignore if attachment fails (e.g. empty log)
    });
  },
});
