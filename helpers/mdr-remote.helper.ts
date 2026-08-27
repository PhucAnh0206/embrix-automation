import { execFile } from 'child_process';
import { promisify } from 'util';
import { TestLogger } from './test-logger';

const exec = promisify(execFile);

/**
 * Submit a meter reading through the REAL MDR pipeline, over SSH.
 *
 * The loader is not in this repo: it lives on the jumphost, under a per-environment
 * tree, and is driven by scripts kept in `Embrix/Regression testing/_scripts/`. This
 * helper reuses the two pieces already deployed there rather than reimplementing the
 * file format:
 *
 *   calc/make-mdr.sh <METER> <ABSOLUTE_READING> <OUT_DIR>
 *       writes one HDR/DET/TRL CSV. It anchors its timestamps to `core_config.ccp_time`
 *       and builds a unique `usageid` itself — both load-bearing. A wall-clock
 *       timestamp ahead of the frozen CCP clock is rejected as a future transaction,
 *       and a repeated usageid collides on `fdr_usageid__idx`, leaving the reading
 *       PENDING forever in a way that looks exactly like "rating never happened".
 *
 *   ./load_energy_usage_cdrs.sh
 *       picks the file up out of `$CDR_IN_DIR/input` and pushes it into mediation.
 *
 * Readings are ABSOLUTE odometer values, not deltas: the pipeline rates
 * `new_reading - previous_reading`, so a value at or below the meter's current
 * position is rejected rather than rated.
 *
 * Requires an ssh host alias (default `embrix-dev`, the same one
 * `Regression testing/deploy.ps1` uses) resolvable from ~/.ssh/config with key auth.
 */
export class MdrRemoteHelper {
  private readonly host: string;
  private readonly workDir: string;

  constructor(private logger?: TestLogger, opts: { host?: string; workDir?: string } = {}) {
    this.host = opts.host ?? process.env.MDR_SSH_HOST ?? 'embrix-dev';
    this.workDir =
      opts.workDir ?? process.env.MDR_WORK_DIR ?? '/jasec-energy/data/jasec/usage/energy';
  }

  /** Run a command on the jumphost. Throws with both streams on non-zero exit. */
  private async ssh(command: string, timeoutMs = 180_000): Promise<string> {
    try {
      const { stdout, stderr } = await exec(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', this.host, command],
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      );
      // The jumphost prints a post-quantum KEX warning on every connection; it is
      // noise, not failure, and would otherwise dominate every log line.
      const clean = (stderr ?? '')
        .split('\n')
        .filter((l) => !/post-quantum|store now, decrypt later|openssh\.com\/pq|may need to be upgraded/i.test(l))
        .join('\n')
        .trim();
      if (clean) this.logger?.log(`ssh stderr: ${clean}`);
      return stdout;
    } catch (err: any) {
      throw new Error(
        `ssh ${this.host} failed: ${err.message}\n` +
        `stdout: ${err.stdout ?? ''}\nstderr: ${err.stderr ?? ''}`,
      );
    }
  }

  /** Is the jumphost reachable and does it have the loader tree? */
  async isAvailable(): Promise<boolean> {
    try {
      const out = await this.ssh(
        `test -f ${this.workDir}/load_energy_usage_cdrs.sh && ` +
        `test -f ${this.workDir}/calc/make-mdr.sh && echo READY`,
        30_000,
      );
      return /READY/.test(out);
    } catch {
      return false;
    }
  }

  /**
   * Generate one MDR file for `meter` at absolute reading `readingKwh`, then run the
   * loader. Returns the script output, which names the file and reports the delta the
   * pipeline will actually rate.
   *
   * DBURL is read out of the remote `properties.config` rather than assumed from the
   * environment: a fresh SSH session does not source ~/.bashrc, so without this
   * make-mdr.sh cannot read the CCP clock and silently falls back to wall clock —
   * which then gets the file rejected as a future transaction.
   */
  async submitReading(meter: string, readingKwh: number | string): Promise<string> {
    const script = [
      `cd ${this.workDir}`,
      `DBURL=$(grep -E '^PG_DB_URL=' properties.config | cut -d '=' -f2- | tr -d '"' | tr -d "'")`,
      `export DBURL`,
      `IN_DIR=$(grep -E '^CDR_IN_DIR=' properties.config | cut -d '=' -f2- | tr -d '"' | tr -d "'")/input`,
      `bash calc/make-mdr.sh '${meter}' '${readingKwh}' "$IN_DIR"`,
      `./load_energy_usage_cdrs.sh`,
    ].join(' && ');

    this.logger?.log(`MDR: submitting reading ${readingKwh} kWh for meter ${meter}`);
    const out = await this.ssh(script);
    for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 40)) {
      this.logger?.log(`  mdr| ${line}`);
    }
    return out;
  }
}
