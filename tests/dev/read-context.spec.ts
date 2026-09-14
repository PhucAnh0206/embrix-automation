/**
 * Tags: @dev_test
 *
 * Demonstrates the test-context helper. Runs in the `dev` project only —
 * never in `regression`.
 *
 * Each example SEEDS its own context before reading it. That matters: context
 * is scoped per spec file (`test-context.read-context.json`), so this spec
 * cannot see — and must not depend on — data left behind by ts-01 or ts-02.
 * It previously did exactly that, and wrote its placeholder ids into the
 * then-shared file, where other suites read them back as real data.
 */

import { test, expect } from '../../fixtures/page-factory';
import {
  loadTestContext,
  updateTestContext,
  SavedContext
} from '../../helpers/test-context.helper';

test.describe('Detailed Guide to Managing Test Context', () => {

  // Method 1: Using helper functions imported directly
  test('Example 1: Read, use, and update via Direct Helper', async ({ testLogger }) => {

    testLogger.log('=== STEP 1: SEED THIS SPEC OWN CONTEXT ===');
    // Nothing else writes to this spec's scope, so seed before reading.
    updateTestContext({
      accountId: 'ACT-DEMO-0001',
      orderId: 'ORD-DEMO-0001',
    });

    testLogger.log('=== STEP 2: READ DATA FROM CONTEXT ===');
    const context: SavedContext = loadTestContext();
    testLogger.data('Current context content', context);

    testLogger.log('=== STEP 3: RETRIEVE AND USE DATA ===');
    console.log(`- Account ID: ${context.accountId}`);
    console.log(`- Order ID: ${context.orderId}`);
    expect(context.accountId).toBe('ACT-DEMO-0001');
    expect(context.orderId).toBe('ORD-DEMO-0001');

    testLogger.log('=== STEP 4: UPDATE/MERGE NEW DATA INTO CONTEXT ===');
    updateTestContext({
      invoiceId: 'INV-DIRECT-12345',
      totalAmount: '12,345.67',
    });

    testLogger.log('=== STEP 5: VERIFY THE MERGE ===');
    const updatedContext = loadTestContext();
    testLogger.data('New context content after merge', updatedContext);
    // update() merges — it must add the new keys WITHOUT dropping the seeded ones.
    expect(updatedContext.invoiceId).toBe('INV-DIRECT-12345');
    expect(updatedContext.totalAmount).toBe('12,345.67');
    expect(updatedContext.accountId).toBe('ACT-DEMO-0001');
  });

  // Method 2: Using the custom fixture `testContext` via Playwright Dependency Injection (Recommended)
  test('Example 2: Thao tác through custom fixture `testContext`', async ({ testLogger, testContext }) => {

    testLogger.log('=== STEP 1: SEED VIA FIXTURE ===');
    testContext.update({
      accountId: 'ACT-DEMO-0002',
      orderId: 'ORD-DEMO-0002',
    });

    testLogger.log('=== STEP 2: READ DATA FROM FIXTURE ===');
    const context: SavedContext = testContext.load();
    testLogger.data('Context content (Fixture)', context);
    expect(context.accountId).toBe('ACT-DEMO-0002');

    testLogger.log('=== STEP 3: UPDATE DATA VIA FIXTURE ===');
    testContext.update({
      invoiceId: 'INV-FIXTURE-67890',
      totalAmount: '67,890.12',
    });

    testLogger.log('=== STEP 4: VERIFY DATA AFTER UPDATE ===');
    const updatedContext = testContext.load();
    testLogger.data('New context content (Fixture)', updatedContext);
    expect(updatedContext.invoiceId).toBe('INV-FIXTURE-67890');
    expect(updatedContext.accountId).toBe('ACT-DEMO-0002');
  });
});
