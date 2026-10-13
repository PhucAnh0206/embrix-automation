/**
 * NetSuite regression — per-case result recording.
 *
 * Every test title starts with its Case ID ("INV-003: ..."). A test records
 * what it actually saw with `actual()`, saves NetSuite payloads with
 * `evidence()`, and — when it cannot run — says why with `blocked()` /
 * `devOnly()` / `needsConfirmation()`. reporters/netsuite-csv.reporter.ts turns
 * that into the Actual Result / Status columns of the suite CSV.
 */
import { test, TestInfo } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export const SUITE_DIR = 'D:/Dev/products/Embrix/test-cases/netsuite';
export const EVIDENCE_DIR = path.join(SUITE_DIR, 'evidence', 'R2');

export type NsStatus = 'Blocked' | 'Not run' | 'Need confirmation' | 'Not applicable';

export function actual(text: string, info: TestInfo = test.info()): void {
  info.annotations.push({ type: 'ns-actual', description: text });
}

/** Saves JSON/text evidence under evidence/R2 and attaches it to the report. */
export function evidence(name: string, data: unknown, info: TestInfo = test.info()): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const caseId = info.title.split(':')[0].trim();
  const file = path.join(EVIDENCE_DIR, `${caseId}-${name}`.replace(/[^\w.-]+/g, '_') + (typeof data === 'string' ? '.txt' : '.json'));
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  info.annotations.push({ type: 'ns-evidence', description: path.basename(file) });
  return file;
}

function skipWith(status: NsStatus, reason: string): never {
  const info = test.info();
  info.annotations.push({ type: 'ns-status', description: status });
  actual(reason, info);
  test.skip(true, `${status}: ${reason}`);
  throw new Error('unreachable');
}

export const blocked = (reason: string) => skipWith('Blocked', reason);
export const devOnly = (reason: string) => skipWith('Not run', `Dev/platform-side: ${reason}`);
export const needsConfirmation = (reason: string) => skipWith('Need confirmation', reason);
export const notApplicable = (reason: string) => skipWith('Not applicable', reason);

/** Records a "Need confirmation" outcome for a case that DID run (record-only cases). */
export function recordOnly(text: string): void {
  const info = test.info();
  info.annotations.push({ type: 'ns-status', description: 'Need confirmation' });
  actual(text, info);
}

/** Shared state between specs in one run (ids created earlier). */
const STATE_FILE = path.join(SUITE_DIR, 'evidence', 'R2', '_state.json');
export function saveState(key: string, value: unknown): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const s = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  s[key] = value;
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
export function loadState<T = any>(key: string): T | undefined {
  if (!fs.existsSync(STATE_FILE)) return undefined;
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))[key];
}

/**
 * Runs `make` once per test run (NS_RUN_ID) and returns the same value on any
 * later call — including from a worker restarted after a failed case — so a
 * failure never causes duplicate invoices or contracts.
 */
export async function once<T>(key: string, make: () => Promise<T>): Promise<T> {
  const run = process.env.NS_RUN_ID ?? 'adhoc';
  const hit = loadState<{ run: string; value: T }>(`once:${key}`);
  if (hit && hit.run === run) return hit.value;
  const value = await make();
  saveState(`once:${key}`, { run, value });
  return value;
}
