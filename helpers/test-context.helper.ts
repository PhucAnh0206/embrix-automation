import * as fs from 'fs';
import * as path from 'path';
import { InvoiceParams } from '../pages/customer-hub/customer-management/account-details/billing-data/bills.page';

/**
 * Mapped interface for storing test session IDs and configuration contexts.
 */
export interface SavedContext {
  testingDateObj?: {
    startDate: string; // Date for creating account, order
    nextMonthFirstDate: string; // 1st day of the next month jobs (recurring month 01)
    nextTwoMonthsFirstDate: string; // 1st day of the next two months jobs (recurring month 02)
    nextThreeMonthsFirstDate: string; // 1st day of the next three months jobs (recurring month 03)
    nextFourMonthsFirstDate: string; // 1st day of the next four months jobs (recurring month 04)
    nextFiveMonthsFirstDate: string; // 1st day of the next five months jobs (recurring month 05)
    nextSixMonthsFirstDate: string; // 1st day of the next six months jobs (recurring month 06)

    nextTwoMonthsSixteenth: string; // 16th day of the next two months jobs (due date for recurring month 02)
    nextTwoMonthsSeventeenth: string; // 17th day of the next two months jobs (collection date for recurring month 02)
    nextTwoMonthsTwentyFirst: string; // 21th day of the next two months jobs (suspend date for recurring month 02)
  };

  accountId: string;
  orderId: string;
  subscriptionId?: string;

  accountInfoPageUrl?: string;
  billsPageUrl?: string;
  servicesPageUrl?: string;
  orderDetailsPageUrl?: string;

  billList?: string[];
  pendingBillList?: string[];

  recurringMonth01InvoiceId?: string;
  recurringMonth02InvoiceId?: string;
  recurringMonth02BillUnitId?: string;
  recurringMonth03InvoiceId?: string;
  recurringMonth04InvoiceId?: string;
  recurringMonth05InvoiceId?: string;

  provisioningOrderUrl?: string;
  provisioningOrderId?: string;
  requestContent?: string;

  recurringMonth01InvoiceDetails?: InvoiceParams;
  recurringMonth02InvoiceDetails?: InvoiceParams;
  recurringMonth03InvoiceDetails?: InvoiceParams;
  recurringMonth04InvoiceDetails?: InvoiceParams;
  recurringMonth05InvoiceDetails?: InvoiceParams;
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
