import * as fs from 'fs';
import * as path from 'path';

/**
 * TestLogger — Writes structured log entries to a file in test-results/logs/.
 *
 * Categories:
 *   [LOG]   – General information
 *   [DATA]  – Saved / captured data (accountId, orderId, URLs, etc.)
 *   [API]   – API request/response details
 *   [ERROR] – Errors and warnings
 *
 * The log file is created lazily on the first write and flushed at the end of
 * each test via the logger fixture.
 */
export class TestLogger {
  private buffer: string[] = [];
  private filePath: string;
  private flushed = false;

  constructor(testTitle: string) {
    const sanitized = testTitle
      .replace(/[^a-zA-Z0-9_\-]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 80);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(process.cwd(), 'test-results', 'logs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, `${sanitized}_${timestamp}.log`);
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** General log message. */
  log(message: string): void {
    this.write('LOG', message);
  }

  /** Log saved / captured data with a label. */
  data(label: string, value: unknown): void {
    const formatted = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    this.write('DATA', `${label} = ${formatted}`);
  }

  /**
   * Log an API call.
   * @param method  HTTP method (GET, POST, …)
   * @param url     Full request URL
   * @param status  Response status code (optional, omit for request-only logs)
   * @param body    Response body (optional)
   */
  api(method: string, url: string, status?: number, body?: string): void {
    if (status !== undefined) {
      this.write('API', `${method} ${url} → ${status}`);
      if (body) {
        this.write('API', `Response Body: ${body}`);
      }
    } else {
      this.write('API', `${method} ${url}`);
    }
  }

  /** Log an error or warning. */
  error(message: string, detail?: unknown): void {
    const extra = detail
      ? `\n${typeof detail === 'object' ? JSON.stringify(detail, null, 2) : String(detail)}`
      : '';
    this.write('ERROR', `${message}${extra}`);
  }

  /** Flush buffer to disk. Safe to call multiple times. */
  flush(): void {
    if (this.flushed || this.buffer.length === 0) return;
    fs.writeFileSync(this.filePath, this.buffer.join('\n') + '\n', 'utf-8');
    this.flushed = true;
  }

  /** Return the absolute path to the log file (for Playwright attachments). */
  getFilePath(): string {
    return this.filePath;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private write(category: string, message: string): void {
    const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const entry = `[${ts}] [${category}] ${message}`;
    this.buffer.push(entry);

    // 1. Print to console for real-time visibility in Terminal and Playwright UI Mode (Console tab)
    console.log(entry);

    // 2. Append directly to log file so it updates in real-time on disk
    try {
      fs.appendFileSync(this.filePath, entry + '\n', 'utf-8');
    } catch (e) {
      // Fallback if append fails
    }

    // Reset flushed flag
    this.flushed = false;
  }
}
