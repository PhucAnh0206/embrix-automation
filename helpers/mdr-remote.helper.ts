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

  /**
   * Is the jumphost reachable and does it have the loader tree?
   *
   * RETRIES, because a single failure here is a FALSE SKIP. Observed on
   * jasec-dev 2026-09-15: this spec's test B blocked every time it ran
   * immediately after test A, and passed on its own — the jumphost intermittently
   * refuses a connection that arrives on the heels of a burst. A BLOCKED verdict
   * from one transient refusal silently removes real coverage from the run, which
   * is worse than a failure because nobody goes looking for it.
   */
  async isAvailable(attempts = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (await this.probeOnce(attempt, attempts)) return true;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
    return false;
  }

  private async probeOnce(attempt: number, attempts: number): Promise<boolean> {
    try {
      const out = await this.ssh(
        `test -f ${this.workDir}/load_energy_usage_cdrs.sh && ` +
        `test -f ${this.workDir}/calc/make-mdr.sh && echo READY`,
        30_000,
      );
      return /READY/.test(out);
    } catch (err: any) {
      /**
       * Never swallow this silently. A bare `return false` turns every distinct
       * cause — VPN down, key not loaded, wrong alias, a work dir that does not
       * exist on this tenant — into the same unhelpful BLOCKED line, and the
       * same blind catch on `submitReading` already cost two full runs once.
       */
      /**
       * Report the exit code and BOTH streams, not a truncated message. `test -f`
       * returning false and ssh being refused look identical in `err.message`
       * alone, and they call for opposite responses: the first means the work dir
       * is wrong for this tenant, the second means wait and try again.
       */
      const detail = [
        `exit=${err?.code ?? '?'}`,
        err?.stdout ? `stdout=${String(err.stdout).trim().slice(0, 200)}` : 'stdout=<empty>',
        err?.stderr ? `stderr=${String(err.stderr).trim().slice(0, 300)}` : 'stderr=<empty>',
      ].join(' ');
      const msg =
        `MDR availability probe ${attempt}/${attempts} failed for ` +
        `${this.host}:${this.workDir} -> ${detail}`;
      this.logger?.log(msg);
      console.log(`  ${msg}`);
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
  async submitReading(meter: string, readingKwh: number | string, attempts = 3): Promise<string> {
    const script = [
      `cd ${this.workDir}`,
      `DBURL=$(grep -E '^PG_DB_URL=' properties.config | cut -d '=' -f2- | tr -d '"' | tr -d "'")`,
      `export DBURL`,
      `IN_DIR=$(grep -E '^CDR_IN_DIR=' properties.config | cut -d '=' -f2- | tr -d '"' | tr -d "'")/input`,
      `bash calc/make-mdr.sh '${meter}' '${readingKwh}' "$IN_DIR"`,
      // 2>&1 ON THE REMOTE SIDE, and it is load-bearing. The loader writes
      // `ERROR: Failed pushing file to MEDIATION queue` and the stomp traceback
      // to STDERR, while `ssh()` below returns stdout only. Without this fold the
      // push-failure detector below never sees the error, silently skips the
      // retry, and the caller waits out its full timeout for a record that was
      // never created. Cost two full runs before it was spotted.
      `./load_energy_usage_cdrs.sh 2>&1`,
    ].join(' && ');

    let out = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.logger?.log(
        `MDR: submitting reading ${readingKwh} kWh for meter ${meter}` +
        (attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''),
      );
      out = await this.ssh(script);
      for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 40)) {
        this.logger?.log(`  mdr| ${line}`);
      }
      if (!MdrRemoteHelper.isQueuePushFailure(out)) return out;

      /**
       * THE AMQ PUSH TRANSIENT, retried here rather than left to every caller.
       *
       *     Pushing file <MDR_PREPAGO_...csv> to MEDIATION queue
       *     ERROR: Failed pushing file to MEDIATION queue
       *     Moving file to error directory
       *
       * The file is fine — the loader's push to ActiveMQ failed — and the file is
       * moved to error/ so NO record is ever written. That is the important part:
       * it does not park, fail or stay pending, it simply never appears, which
       * reads exactly like "rating never happened". Measured at roughly 7% of
       * drops on jasec-dev, and the E2E guide's own advice is to re-drop the same
       * content under a new timestamp.
       *
       * The retry must RE-SUBMIT, not re-check: make-mdr.sh names the file from
       * the clock to the second, so the sleep below is also what guarantees a new
       * file name and a new usageid rather than a duplicate collision.
       */
      if (attempt < attempts) {
        /**
         * BACK OFF PAST THE CRON TICK, don't just retry quickly.
         *
         * The loader cron runs EVERY MINUTE, and a manual drop that lands while
         * a cron instance is pushing loses the race. Measured on jasec-dev
         * 2026-09-15 — every failure was a second push landing inside the same
         * minute-window as another loader run:
         *
         *     083502 pushed   083515 PUSH-FAILED   (13s later)
         *     082927 pushed   082939 PUSH-FAILED   (12s later)
         *     065601 pushed   065702 PUSH-FAILED   (61s later, collided with cron)
         *
         * A 3s retry therefore lands inside the same window and fails again. 25s
         * clears it and still leaves the run quick.
         */
        this.logger?.log('MDR: AMQ push failed — re-dropping with a new timestamp in 25s (clears the cron tick)');
        await new Promise((r) => setTimeout(r, 25_000));
      }
    }

    throw new Error(
      `MDR: the loader failed to push the file to the MEDIATION queue ${attempts} times for ` +
      `meter ${meter} at reading ${readingKwh}. This is the AMQ transient, not a bad file — ` +
      `but ${attempts} in a row suggests the broker is down. Last output:\n${out.slice(-800)}`,
    );
  }

  /**
   * Did the loader accept the file but fail to hand it to ActiveMQ?
   *
   * Three signatures, because the failure surfaces differently depending on how
   * far the push got — the shell's own ERROR line, the python STOMP exception
   * underneath it, and the move to error/ that follows either.
   */
  static isQueuePushFailure(loaderOutput: string): boolean {
    return /Failed pushing file to MEDIATION queue/i.test(loaderOutput)
      || /stomp\.exception\.ConnectFailedException|ConnectFailedException/i.test(loaderOutput)
      || /Moving file to error directory/i.test(loaderOutput);
  }
}
