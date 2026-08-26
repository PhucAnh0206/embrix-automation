/**
 * Single source for the Embrix login used by automation.
 *
 * WHY THIS EXISTS. The credential lookup was copy-pasted in three places with
 * two different behaviours:
 *
 *   • tests/auth.setup.ts and helpers/server-api.helper.ts read the env vars and
 *     THROW a clear message when they are missing.
 *   • fixtures/create-prepaid-account.helper.ts and the TS-04 reconnection spec
 *     silently fell back to a literal `congeroadmin` / `congero@123`.
 *
 * The silent fallback was worse than a missing value in both directions: it put a
 * real credential in the source of a public repository, and it turned "you forgot
 * to set .env" into a confusing login failure against whatever environment the
 * literal happens to still be valid on.
 *
 * Resolution is LAZY — called at use time, not at module load — so a spec file
 * can still be collected (and reported as skipped) on a machine with no .env,
 * instead of failing the whole run at import.
 */

/** The configured Embrix username. Throws if EMBRIX_USER is not set. */
export function embrixUser(): string {
  return required('EMBRIX_USER');
}

/** The configured Embrix password. Throws if EMBRIX_PASSWORD is not set. */
export function embrixPassword(): string {
  return required('EMBRIX_PASSWORD');
}

/** Both credentials at once, for callers that pass them straight to a login. */
export function embrixCredentials(): { username: string; password: string } {
  return { username: embrixUser(), password: embrixPassword() };
}

function required(name: 'EMBRIX_USER' | 'EMBRIX_PASSWORD'): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. EMBRIX_USER and EMBRIX_PASSWORD must both come from the ` +
      `environment — copy .env.example to .env and fill them in. There is deliberately ` +
      `no built-in default: a hardcoded credential in this repo is a leak, and a wrong ` +
      `one fails as an unexplained login error.`,
    );
  }
  return value;
}
