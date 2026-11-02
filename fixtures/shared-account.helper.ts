/**
 * SharedAccount — create one JASEC prepaid account and reuse it across the tests
 * in a spec file, instead of paying for a fresh one per test.
 *
 * WHY IT MATTERS. Creating an account is by far the most expensive thing these
 * suites do: it walks the Core UI account form, then the whole order wizard
 * (bundle, meter provisioning, submit, poll to COMPLETED), then logs into Self
 * Care and selects the account. Measured on the 2026-08-20 run, a test that
 * creates its own account costs 150-250s; one that attaches to an existing
 * account costs 60-70s. So every account creation removed is roughly two minutes
 * off the suite.
 *
 * WHAT IT IS. A lazily-populated, per-worker cache with two caller-supplied
 * steps: `create` runs once, `attach` runs on every reuse. It is deliberately
 * NOT a `beforeAll` hook, because a hook forces the cost onto every run of the
 * file even when only one test is selected — with this, running a single test
 * with `--grep` still works: whichever test asks first does the create.
 *
 * WHY `attach` IS NOT OPTIONAL. The ACCOUNT is shared, the BROWSER SESSION is
 * not: Playwright gives every test a fresh page, so the Self Care login from the
 * creating test does not carry over. Skipping the re-attach makes the second
 * test fail on its first navigation with a missing Activity tab.
 *
 * LIFETIME — read this before relying on it. The cache lives in the WORKER
 * PROCESS, so it is lost when Playwright restarts the worker, which it does
 * after a test failure and on every retry. The next consumer then creates a
 * fresh account rather than failing on missing state, which is the safe
 * behaviour — but it does mean the saving silently disappears in a run that has
 * failures. That was observed on 2026-08-20: TC 2.5 failed, the worker
 * restarted, and TC 2.6 re-created the Group A account (200.9s) where its
 * siblings that attached took 61-70s. `ensure()` logs which path it took, so
 * this is visible in the report instead of being a mystery.
 */

import type { TestLogger } from '../helpers/test-logger';

export interface SharedAccountOptions<F> {
  /** Shown in logs, e.g. 'TS-02 Group A'. */
  label: string;
  /** Build the account from scratch, including any one-time bootstrap. */
  create: (fixtures: F) => Promise<string>;
  /** Point THIS test's fresh page at the already-created account. */
  attach: (fixtures: F, accountId: string) => Promise<void>;
}

export class SharedAccount<F extends { testLogger: TestLogger }> {
  private accountId: string | null = null;

  constructor(private readonly options: SharedAccountOptions<F>) { }

  /** Has this worker already built the account? */
  get isCreated(): boolean {
    return this.accountId !== null;
  }

  /**
   * The shared account id, creating it on first use and re-attaching the current
   * page to it on every subsequent use.
   */
  async ensure(fixtures: F): Promise<string> {
    const { label, create, attach } = this.options;

    if (this.accountId !== null) {
      fixtures.testLogger.log(
        `[${label}] reusing shared account ${this.accountId} — re-attaching this page`,
      );
      await attach(fixtures, this.accountId);
      return this.accountId;
    }

    fixtures.testLogger.log(
      `[${label}] creating the shared account — first consumer in THIS WORKER. ` +
      `Expect the full setup cost here; later tests in the file attach instead.`,
    );
    const accountId = await create(fixtures);
    this.accountId = accountId;
    fixtures.testLogger.log(`[${label}] shared account ready: ${accountId}`);
    return accountId;
  }
}
