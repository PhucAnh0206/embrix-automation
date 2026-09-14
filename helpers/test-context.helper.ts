import * as fs from 'fs';
import * as path from 'path';
import { test } from '@playwright/test';

/**
 * Mapped interface for storing test session IDs and configuration contexts.
 */
export interface SavedContext {
  testingDateObj?: {
    startDate: string;
    nextMonthFirstDate: string;
    nextTwoMonthsFirstDate: string;
    nextThreeMonthsFirstDate: string;
    nextFourMonthsFirstDate: string;
    nextFiveMonthsFirstDate: string;
  };
  accountId: string;
  orderId: string;
  accountInfoPageUrl?: string;
  billsPageUrl?: string;
  invoiceId?: string;
  totalAmount?: string;
  provisioningOrderUrl?: string;
  provisioningOrderId?: string;
  requestContent?: string;
  quickAccUrl?: string;
  incompleteOrderId?: string;
  orderUrl?: string;
  currencyUrl?: string;
  productFamilyUrl?: string;
  taxationUrl?: string;
  amount?: string;
  endDate?: string;
  subscriptionId?: string;
}

const CONTEXT_DIR = path.join(process.cwd(), 'playwright', '.auth');

/**
 * Context is scoped to the SPEC FILE that is running, not shared globally.
 *
 * There used to be one `test-context.json` for every suite. Because
 * `loadTestContext()` is used as a fallback (`state.x = state.x ?? saved.x`),
 * a suite could silently adopt another suite's identifiers. Observed on
 * 2026-09-11: `ts-02` picked up `accountId: "AC-851341"` and
 * `invoiceId: "INV-FIXTURE-67890"` — neither from its own run. The second of
 * those is a literal placeholder written by `read-context.spec.ts`, a
 * documentation demo that runs inside the regression project and wrote fake
 * values into the live shared file.
 *
 * Scoping per spec file (not per directory) is deliberate: the demo spec and
 * `ts-01` live in the same folder, so directory scoping would not have
 * separated them.
 *
 * Falls back to `shared` only when called outside a running test, where
 * `test.info()` is unavailable.
 */
function contextFile(): string {
  let scope = 'shared';
  try {
    scope = path.basename(test.info().file).replace(/\.spec\.ts$/, '');
  } catch {
    // Not inside a test worker — keep the neutral scope.
  }
  return path.join(CONTEXT_DIR, `test-context.${scope}.json`);
}

/**
 * Persists the current test context details to the disk.
 * @param context - The context object to be written.
 */
export function saveTestContext(context: SavedContext): void {
  const file = contextFile();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(file, JSON.stringify(context, null, 2), 'utf-8');
}

/**
 * Loads the saved test context file from the disk.
 * @returns The deserialized SavedContext object.
 * @throws Error if the test context file is not present.
 */
export function loadTestContext(): SavedContext {
  const file = contextFile();
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8');
    return JSON.parse(content) as SavedContext;
  }
  throw new Error(`Test context file not found at ${file}. Make sure to create account and order first.`);
}

/**
 * Merge partial data into the existing test context file.
 * Creates the file if it doesn't exist yet.
 */
export function updateTestContext(partial: Partial<SavedContext>): void {
  const file = contextFile();
  let existing: Partial<SavedContext> = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { /* start fresh */ }
  }
  const merged = { ...existing, ...partial };
  saveTestContext(merged as SavedContext);
}
