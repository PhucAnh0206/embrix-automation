/**
 * Tags: @dev_test
 * Test file to demonstrate how to use the test context in coopeguanacaste project.
 */

import { test } from '../../../fixtures/page-factory';
import {
  loadTestContext,
  updateTestContext,
  SavedContext
} from '../../../helpers/test-context.helper';

test.describe('Detailed Guide to Managing Test Context', () => {

  // Method 1: Using helper functions imported directly
  test('Example 1: Read, use, and update via Direct Helper', async ({ testLogger }) => {

    testLogger.log('=== STEP 1: READ DATA FROM CONTEXT ===');
    let context: SavedContext;
    try {
      context = loadTestContext();
      testLogger.log('Context file read successfully!');
    } catch (error: any) {
      testLogger.error('Error reading context file: ' + error?.message);
      return;
    }

    testLogger.data('Current context content', context);

    testLogger.log('=== STEP 2: RETRIEVE AND USE DATA ===');
    console.log(`- Account ID: ${context.accountId}`);
    console.log(`- Order ID: ${context.orderId}`);

    testLogger.log('=== STEP 3: UPDATE/MERGE NEW DATA INTO CONTEXT ===');
    updateTestContext({
      invoiceId: 'INV-DIRECT-12345',
      totalAmount: '12,345.67',
    });
    testLogger.log('New fields added to context successfully!');

    testLogger.log('=== STEP 4: VERIFY DATA AFTER UPDATE ===');
    const updatedContext = loadTestContext();
    testLogger.data('New context content after merge', updatedContext);
  });

  // Method 2: Using the custom fixture `testContext` via Playwright Dependency Injection (Recommended)
  test('Example 2: Thao tác through custom fixture `testContext`', async ({ testLogger, testContext }) => {

    testLogger.log('=== STEP 1: READ DATA FROM FIXTURE ===');
    let context: SavedContext;
    try {
      context = testContext.load();
      testLogger.log('Context file read via fixture successfully!');
    } catch (error: any) {
      testLogger.error('Error reading context file via fixture: ' + error?.message);
      return;
    }

    testLogger.data('Context content (Fixture)', context);

    testLogger.log('=== STEP 2: UPDATE DATA VIA FIXTURE ===');
    testContext.update({
      invoiceId: 'INV-FIXTURE-67890',
      totalAmount: '67,890.12',
    });

    testLogger.log('=== STEP 3: VERIFY DATA AFTER UPDATE ===');
    const updatedContext = testContext.load();
    testLogger.data('New context content (Fixture)', updatedContext);
  });
});
