import * as fs from 'fs';
import * as path from 'path';

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

const CONTEXT_FILE = path.join(process.cwd(), 'playwright', '.auth', 'test-context.json');

/**
 * Persists the current test context details to the disk.
 * @param context - The context object to be written.
 */
export function saveTestContext(context: SavedContext): void {
  const dir = path.dirname(CONTEXT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2), 'utf-8');
}

/**
 * Loads the saved test context file from the disk.
 * @returns The deserialized SavedContext object.
 * @throws Error if the test context file is not present.
 */
export function loadTestContext(): SavedContext {
  if (fs.existsSync(CONTEXT_FILE)) {
    const content = fs.readFileSync(CONTEXT_FILE, 'utf-8');
    return JSON.parse(content) as SavedContext;
  }
  throw new Error(`Test context file not found at ${CONTEXT_FILE}. Make sure to create account and order first.`);
}

/**
 * Merge partial data into the existing test context file.
 * Creates the file if it doesn't exist yet.
 */
export function updateTestContext(partial: Partial<SavedContext>): void {
  let existing: Partial<SavedContext> = {};
  if (fs.existsSync(CONTEXT_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
    } catch { /* start fresh */ }
  }
  const merged = { ...existing, ...partial };
  saveTestContext(merged as SavedContext);
}
