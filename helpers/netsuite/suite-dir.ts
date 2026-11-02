import * as fs from 'fs';
import * as path from 'path';

/**
 * The NetSuite suite folder: client file (NetSuite_Regression_TestSuite…csv), tools, internal checks, eft-106 documents,
 * and where results and evidence are written. NS_SUITE_DIR wins; else the QC workspace's test-cases\netsuite two levels
 * above this repo (the maintained copy); else the copy shipped in this repo (netsuite-suite\), so a plain clone runs.
 */
export function suiteDir(): string {
  if (process.env.NS_SUITE_DIR) return process.env.NS_SUITE_DIR;
  const repo = path.resolve(__dirname, '..', '..');
  const workspace = path.resolve(repo, '..', '..', 'test-cases', 'netsuite');
  return fs.existsSync(workspace) ? workspace : path.join(repo, 'netsuite-suite');
}
