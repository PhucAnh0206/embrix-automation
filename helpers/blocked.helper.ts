import { test } from '@playwright/test';

/**
 * Report an unmet PRECONDITION as BLOCKED rather than as a failure.
 *
 * The rule this encodes is the suite's own: a case that never reached the
 * product has not tested it, and calling that a FAIL misreports the product.
 * On the 2026-09-14 preprod run twelve cases went red across two blocks, and
 * every one of them was missing test data — no invoices on the tenant, no
 * notification rows of a given type to replay, no suspended account in the
 * required debt range. Each spec already printed an accurate diagnosis and then
 * threw anyway, so the report said "12 failed" about a product that had not
 * been exercised. Someone reading that goes looking for a defect that is not
 * there, which is a worse outcome than no coverage.
 *
 * Two things have to happen together, which is why this is a helper and not
 * just a `test.skip` call:
 *
 *  1. `test.skip()` marks the case skipped, so it leaves the failure count.
 *  2. The reason is printed to stdout, because the list reporter does NOT show
 *     a skip's message. Without the console line a BLOCKED case is invisible —
 *     and silent missing coverage is the one outcome worse than a false FAIL.
 *
 * Call it INSIDE a test, after the precondition has been evaluated. It returns
 * true when it blocked, so a caller that needs to stop building state can
 * `if (blockedIf(...)) return;` — though `test.skip()` already aborts the body.
 *
 * Use it ONLY for preconditions — something the environment or the test data
 * failed to provide. A wrong VALUE from the product is a FAIL and must stay
 * one; routing a real defect through here would hide it.
 */
export function blockedIf(condition: boolean, reason: string): boolean {
  if (!condition) return false;
  // eslint-disable-next-line no-console
  console.log(`\n  BLOCKED, not failed: ${reason}\n`);
  test.skip(true, `BLOCKED, not failed: ${reason}`);
  return true;
}
