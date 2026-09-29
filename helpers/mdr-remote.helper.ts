import { execFile } from 'child_process';
import { promisify } from 'util';
import { TestLogger } from './test-logger';
import { TENANTS } from '../config/tenants';

const exec = promisify(execFile);

/**
 * Loader tree per tenant, on the jumphost. Same mapping as `deploy.ps1` and
 * `run-suite.ps1` in Regression testing.
 */
const WORK_DIRS: Record<string, string> = {
  'jasec-dev': '/jasec-energy/data/jasec/usage/energy',
  'jasec-preprod': '/jasec-energy/data/jasec-preprod/usage/energy',
};

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
 *
 * THE TREE FOLLOWS THE TENANT. It used to default to the dev tree whatever
 * TEST_ENV said, so a preprod run seeded preprod's database and dropped its
 * readings into dev's loader - the reading never rated, which looks exactly like
 * a product defect. The tree's own `properties.config` is also checked: its
 * PG_DB_URL must name this tenant's database, or the helper reports unavailable.
 */
export class MdrRemoteHelper {
  private readonly host: string;
  private readonly workDir: string;
  /** Database the loader tree must write to; undefined = cannot tell, not checked. */
  private readonly expectedDb?: string;
  /** Set once the tree's PG_DB_URL has been read and matched. */
  private treeVerified = false;

  constructor(private logger?: TestLogger, opts: { host?: string; workDir?: string } = {}) {
    const tenant = (process.env.TEST_ENV ?? '').trim();
    this.host = opts.host ?? process.env.MDR_SSH_HOST ?? 'embrix-dev';
    const workDir = opts.workDir ?? process.env.MDR_WORK_DIR ?? WORK_DIRS[tenant];
    if (!workDir) {
      throw new Error(
        `MdrRemoteHelper: no MDR loader tree is known for TEST_ENV='${tenant}'. ` +
        `Known: ${Object.keys(WORK_DIRS).join(', ')}. Pass workDir or set MDR_WORK_DIR.`,
      );
    }
    this.workDir = workDir;
    this.expectedDb = TENANTS[tenant]?.dbName ?? (process.env.DB_NAME || undefined);
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
      const result = await this.probeOnce(attempt, attempts);
      if (result === 'ready') return true;
      // A tree wired to another tenant's database will not fix itself on retry.
      if (result === 'wrong-db') return false;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
    return false;
  }

  /**
   * One probe. Also reads the database name out of the tree's PG_DB_URL - only
   * the name, so the credentials in that URL never reach a log.
   */
  private async probeOnce(attempt: number, attempts: number): Promise<'ready' | 'retry' | 'wrong-db'> {
    try {
      const out = await this.ssh(
        `test -f ${this.workDir}/load_energy_usage_cdrs.sh && ` +
        `test -f ${this.workDir}/calc/make-mdr.sh && echo READY && ` +
        `printf 'DB=%s\\n' "$(grep -E '^PG_DB_URL=' ${this.workDir}/properties.config | head -1 | ` +
        `sed -E 's#^.*/([^/?]+)(\\?.*)?$#\\1#' | tr -d "\\"'")"`,
        30_000,
      );
      if (!/READY/.test(out)) return 'retry';
      return this.checkTreeDb(out) ? 'ready' : 'wrong-db';
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
      return 'retry';
    }
  }

  /** Compare the `DB=` line of a probe with this tenant's database. Logs a mismatch. */
  private checkTreeDb(probeOutput: string): boolean {
    const treeDb = (/^DB=(.*)$/m.exec(probeOutput)?.[1] ?? '').trim();
    if (!this.expectedDb) {
      this.treeVerified = true;
      return true;
    }
    if (treeDb === this.expectedDb) {
      this.treeVerified = true;
      return true;
    }
    const msg =
      `MDR loader tree ${this.host}:${this.workDir} writes to database ` +
      `'${treeDb || '(no PG_DB_URL in properties.config)'}', but this run targets ` +
      `'${this.expectedDb}'. A reading dropped there would never rate against this tenant.`;
    this.logger?.log(msg);
    console.log(`  ${msg}`);
    return false;
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
    // Every caller probes first; this covers one that does not.
    if (!this.treeVerified && !(await this.isAvailable())) {
      throw new Error(
        `MDR: loader tree ${this.host}:${this.workDir} is unreachable or wired to another ` +
        `tenant's database (see the log above) - not submitting a reading for ${meter}.`,
      );
    }
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
      if (!MdrRemoteHelper.isQueuePushFailure(out)) {
        /**
         * THE OUTPUT IS NOT THE ONLY PLACE THE PUSH CAN FAIL.
         *
         * `isQueuePushFailure` reads OUR invocation's output. But the loader
         * cron runs EVERY MINUTE, so a cron instance can pick the file up
         * first, fail its push, and leave our `./load_energy_usage_cdrs.sh`
         * with nothing to do and clean output. We then report success for a
         * file that never reached mediation.
         *
         * Observed on jasec-dev 2026-09-29: `@auto-nise` failed with "the 230
         * reading never appeared", and `MDR_PREPAGO_20260826-150009.csv` is
         * FAILED / PUSH_FILE_TO_QUEUE_FAILED in `cdr_load_statistics`. The
         * retry above never fired because our own output was clean. It read as
         * a product defect and cost a wrong diagnosis.
         *
         * So confirm the outcome where it is recorded, not where it is printed.
         * A file that reached PROCESSED is genuinely in; anything else on this
         * filename is the same transient and takes the same retry.
         */
        const verdict = await this.loadVerdict(out);
        if (verdict.ok) return out;
        this.logger?.log(
          `MDR: shell output was clean but the loader recorded ${verdict.detail} — ` +
          `treating as the AMQ push transient (the cron almost certainly won the race)`,
        );
      }

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
   * Did the file this submit produced actually reach the loader's records?
   *
   * Reads `core_mediation.cdr_load_statistics` on the tenant the tree points
   * at, so it cannot be fooled by a clean shell output when the cron performed
   * (and failed) the push. Polls briefly because the row is written by whichever
   * loader instance won the race, which may not be ours.
   *
   * Deliberately conservative: only an explicit PROCESSED is "ok". A missing
   * row is also a failure — when the push fails the file is moved to `error/`
   * and sometimes no record is written at all.
   *
   * Retrying is SAFE for this failure specifically, because the readings never
   * reached mediation: of 93 PUSH_FILE_TO_QUEUE_FAILED files on dev, 91 have no
   * detail rows at all. `make-mdr.sh` names files from the clock, so the re-drop
   * gets a new name and cannot collide as DUPLICATE_FILE.
   */
  private async loadVerdict(loaderOutput: string): Promise<{ ok: boolean; detail: string }> {
    const file = /MDR_[A-Z0-9]+_[0-9]{8}-[0-9]{6}\.csv/.exec(loaderOutput)?.[0];
    if (!file) return { ok: true, detail: 'no filename in output — cannot check, assuming ok' };

    const sql =
      `SELECT coalesce(status,'?')||'|'||coalesce(statusmessage,'') ` +
      `FROM core_mediation.cdr_load_statistics WHERE filename='${file}' ` +
      `ORDER BY startdate DESC LIMIT 1`;
    const probe = [
      `cd ${this.workDir}`,
      `DBURL=$(grep -E '^PG_DB_URL=' properties.config | cut -d '=' -f2- | tr -d '"' | tr -d "'")`,
      `for i in 1 2 3 4 5 6; do R=$(psql "$DBURL" -tA -c "${sql}" 2>/dev/null | tr -d '[:space:]');` +
      ` if [ -n "$R" ]; then echo "VERDICT=$R"; exit 0; fi; sleep 5; done; echo "VERDICT=(no row)"`,
    ].join(' && ');

    const out = await this.ssh(probe, 90_000).catch(() => '');
    const verdict = /VERDICT=(.*)/.exec(out)?.[1]?.trim() ?? '';
    if (verdict.startsWith('PROCESSED')) return { ok: true, detail: verdict };
    return { ok: false, detail: `${file} -> ${verdict || '(probe failed)'}` };
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
