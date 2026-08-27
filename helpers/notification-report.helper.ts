import * as fs from 'fs';
import * as path from 'path';
import { valuesMatch } from './email.helper';
import { TestLogger } from './test-logger';
import type {
  CheckResult,
  NotificationContext,
  NotificationTemplate,
} from '../test-data/notifications/types';

/**
 * NotificationReportHelper — evaluates a NotificationTemplate's field checks
 * against a received email and produces a Jira-ready results table.
 *
 * Per the helper conventions (docs/PLAYWRIGHT_CONVENTIONS.md §6.1) this class
 * contains NO Playwright runner imports and performs NO assertions. It only
 * evaluates and reports. The spec owns `test.step` and `expect.soft`, which
 * keeps the helper reusable outside the runner (e.g. a future CLI that
 * re-checks a saved .eml).
 *
 * Two behaviours worth knowing:
 *
 * 1. EVERY CHECK IS EVALUATED, even after one fails, so a single run fills in
 *    the whole QA table. Stopping at the first bad field would need N runs to
 *    find N defects.
 *
 * 2. KNOWN DEFECTS ARE REPORTED BUT NOT FATAL. A check carrying `knownDefect`
 *    is still evaluated and still reported as Fail; the spec skips asserting
 *    it. That keeps the suite usable as a regression gate while defects are
 *    open. Delete the property when the fix lands and it becomes blocking.
 *
 * Template-agnostic — reused unchanged by every JEPYP-230 notification.
 */
export class NotificationReportHelper {
  constructor(private readonly logger?: TestLogger) { }

  /** Escape pipes / newlines so a value cannot break the markdown table. */
  private static cell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  }

  /**
   * Evaluate one check. Never throws — a check that blows up is reported as a
   * failure with the error text as its actual value, so one bad expectation
   * cannot hide the other fifteen fields.
   */
  private evaluate(
    check: NotificationTemplate['checks'][number],
    ctx: NotificationContext,
  ): CheckResult {
    let expected = '';
    let actual = '';
    let passed = false;

    try {
      expected = check.expected(ctx);
      actual = check.actual(ctx);
      passed = check.compare
        ? check.compare(actual, expected, ctx)
        : valuesMatch(actual, expected);
    } catch (err) {
      actual = `(check threw: ${String(err)})`;
      passed = false;
    }

    return { row: check.row, expected, actual, passed, knownDefect: check.knownDefect };
  }

  /**
   * Evaluate every check in `template` against `ctx`.
   * Returns results in template order; the caller does the asserting.
   */
  evaluateAll(template: NotificationTemplate, ctx: NotificationContext): CheckResult[] {
    return template.checks.map((check) => {
      const result = this.evaluate(check, ctx);

      this.logger?.data(`Check: ${result.row}`, {
        expected: result.expected,
        actual: result.actual,
        result: result.passed ? 'Pass' : result.knownDefect ? 'Fail (known defect)' : 'Fail',
      });

      if (result.knownDefect && result.passed) {
        // Loud on purpose: a known-defect check that starts passing means the
        // fix shipped and the marker should be removed so it blocks again.
        this.logger?.log(
          `✅ ${result.row} — PASSED but is still marked as a known defect ` +
          `(${result.knownDefect}). Remove the knownDefect property from the ` +
          `template so this check starts blocking again.`,
        );
      }

      return result;
    });
  }

  /** Failures that are NOT flagged as known defects — these should fail the run. */
  static unexpectedFailures(results: CheckResult[]): CheckResult[] {
    return results.filter((r) => !r.passed && !r.knownDefect);
  }

  /** Failures matching an open known defect. */
  static knownFailures(results: CheckResult[]): CheckResult[] {
    return results.filter((r) => !r.passed && r.knownDefect);
  }

  /**
   * Build the 3-column table for pasting into a Jira comment. Failure rows
   * carry the observed value so the evidence travels with the table.
   */
  buildJiraTable(
    template: NotificationTemplate,
    ctx: NotificationContext,
    results: CheckResult[],
  ): string {
    const lines: string[] = [];
    lines.push(`### ${template.ticket} — ${template.title}`);
    lines.push('');
    lines.push(
      `Account \`${ctx.accountId}\` · recipient \`${ctx.recipient}\` · ` +
      // Undefined means delivery was never observed — the body came from the
      // stored email_notification row. Saying "delivered in 0s" there would be
      // a false claim in a report that goes to the team.
      `CCP date \`${ctx.ccpDate}\`` + (ctx.deliverySeconds === undefined
        ? ' · body read from the stored notification row (delivery not observed)'
        : ` · delivered in ${ctx.deliverySeconds}s`),
    );
    lines.push('');
    lines.push('| Field | Expected Value | Pass / Fail |');
    lines.push('|---|---|---|');

    for (const r of results) {
      let status: string;
      if (r.passed) {
        status = 'Pass';
      } else if (r.knownDefect) {
        status = `Fail (known) — got "${NotificationReportHelper.cell(r.actual)}"`;
      } else {
        status = `Fail — got "${NotificationReportHelper.cell(r.actual)}"`;
      }
      lines.push(
        `| ${NotificationReportHelper.cell(r.row)} ` +
        `| ${NotificationReportHelper.cell(r.expected)} | ${status} |`,
      );
    }

    const known = NotificationReportHelper.knownFailures(results);
    if (known.length > 0) {
      lines.push('');
      lines.push('**Known open defects**');
      for (const r of known) lines.push(`- ${r.row} — ${r.knownDefect}`);
    }

    return lines.join('\n');
  }

  /**
   * Write the table to test-results/notification-reports/ and return the path,
   * so the spec can attach it to the Playwright report.
   */
  writeReport(template: NotificationTemplate, ctx: NotificationContext, markdown: string): string {
    const dir = path.join(process.cwd(), 'test-results', 'notification-reports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${template.key}_${ctx.accountId}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    this.logger?.data('Notification report written', file);
    return file;
  }
}
