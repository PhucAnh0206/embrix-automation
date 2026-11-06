/**
 * The tenant registry — one place that says which environments exist, where
 * they live, and which suites may run against them.
 *
 * WHY THIS EXISTS. Suite and tenant used to be independent: `--project` chose
 * the specs, a `.env` file chose the target, and nothing checked they agreed.
 * With dozens of projects and several env profiles most combinations are wrong,
 * and only a few are real. Worse, the old resolution fell back to a LIVE tenant when it could
 * not work out which one you meant:
 *
 *     baseURL = EMBRIX_BASE_URL ?? BASE_URLS[ENV] ?? BASE_URLS['coopeg-sandbox']
 *
 * so a typo in TEST_ENV ran the suite against CoopeG without a word. That class
 * of mistake already happened for real: a preprod run raised a SUSPEND order on
 * dev (ORD-1582) because the URLs and the database were configured separately
 * and disagreed. Account ids collide across tenants, so nothing looked wrong.
 *
 * THE RULE. One tenant per run, named by TEST_ENV, and every URL derived from
 * it. Unknown tenant, or a suite that does not belong to it, stops the run
 * before a browser opens.
 */

export interface Tenant {
  /** Core UI, the Playwright baseURL. */
  baseUrl: string;
  /** Transactional GraphQL endpoint. */
  graphqlUrl: string;
  /** Self Care UI, where the tenant has one. */
  selfcareUrl?: string;
  /** CRM gateway, where the tenant has one. */
  crmGatewayUrl?: string;
  /** Database for the few specs that read or clean up directly. DB_NAME must match it. */
  dbName?: string;
  /**
   * Playwright projects allowed against this tenant, by prefix.
   * `*` means any — used only for tenant-agnostic projects like `setup`.
   * A trailing `$` means EXACT name, not prefix: `jasec-accounting$` allows
   * jasec-accounting but not jasec-accounting-run.
   */
  suites: string[];
  /** Shown in errors so a refusal explains itself. */
  note?: string;
}

/** Projects that do not touch a tenant's data and may run anywhere. */
export const TENANT_AGNOSTIC = ['setup', 'unit', 'smoke', 'dev'];

export const TENANTS: Record<string, Tenant> = {
  'jasec-dev': {
    baseUrl: 'https://core-ui.jasec-dev.embrix.org/',
    graphqlUrl: 'https://service-transactional.jasec-dev.embrix.org/graphql',
    selfcareUrl: 'https://selfcare-ui.jasec-dev.embrix.org/',
    crmGatewayUrl: 'https://crm-gateway.jasec-dev.embrix.org',
    dbName: 'coredb-jasec-dev',
    suites: ['jasec-'],
  },

  'jasec-preprod': {
    baseUrl: 'https://core-ui.jasec-preprod.embrix.org/',
    graphqlUrl: 'https://service-transactional.jasec-preprod.embrix.org/graphql',
    // No `-ui` on preprod. dev is selfcare-ui.jasec-dev, preprod is
    // selfcare.jasec-preprod - the `-ui` form does not resolve here, and this
    // registry overwrites SELFCARE_BASE_URL from .env, so a correct .env
    // cannot save you.
    selfcareUrl: 'https://selfcare.jasec-preprod.embrix.org/',
    crmGatewayUrl: 'https://crm-gateway.jasec-preprod.embrix.org',
    dbName: 'coredb-jasec-preprod',
    suites: ['jasec-'],
  },

  // JASEC dev redeployed on OCI (team handover 2026-10-14). A SEPARATE tenant from jasec-dev:
  // own database (in-cluster Postgres on OKE; seed/custom SQL excluded per the OCI deployment
  // checklist), clock 2027-04-09 and 0 accounts at handover, provisioningEnabled=false. Same
  // Core UI login as jasec-dev. Self Care = selfcare.jasec-oci-dev (no -ui; confirmed by Anh
  // 2026-10-14). The DB is reached through an SSH tunnel; there is no control server, so server scripts run
  // from a local tree (see the note).
  'jasec-oci-dev': {
    baseUrl: 'https://core-ui.jasec-oci-dev.embrix.org/',
    graphqlUrl: 'https://service-transactional.jasec-oci-dev.embrix.org/graphql',
    selfcareUrl: 'https://selfcare.jasec-oci-dev.embrix.org/',
    // root answers 404 like jasec-dev's; /graphql answers 401 without auth (same as dev) - it is up.
    crmGatewayUrl: 'https://crm-gateway.jasec-oci-dev.embrix.org',
    // In-cluster Postgres (David's loader diagram, 10-22), reached through the SSH tunnel; this pins the name for the DB guard.
    dbName: 'coredb-jasec-oci-dev',
    suites: ['jasec-'],
    note: 'JASEC dev on OCI. DB via SSH tunnel (127.0.0.1:15432), MDR over SFTP, server scripts in a local tree (no control server).',
  },

  // JASEC PRODUCTION - the client's LIVE environment since 2026-10-20, LOCKED: read-only checks only (build-check
  // customer profile, read-only q.js), no cases, no data, no logins. The suite list is tied to the build through
  // JASEC_PROD_BUILD in the local .env.prod (fail closed):
  //   test-build-*            -> every jasec-* suite (a test build only; each spec keeps its own guards)
  //   anything else or unset  -> NOTHING, not even the tenant-agnostic projects except unit (isSuiteAllowed)
  // .env.prod says final-customer-build. Mutating specs also refuse prod themselves (helpers/prod-guard.ts).
  // A getter, not a value: this module is imported before dotenv.config() runs.
  jasec: {
    baseUrl: 'https://core-ui.jasec.embrix.org/',
    graphqlUrl: 'https://service-transactional.jasec.embrix.org/graphql',
    selfcareUrl: 'https://selfcare-ui.jasec.embrix.org/',
    crmGatewayUrl: 'https://crm-gateway.jasec.embrix.org',
    // On coopeg-prod-db (CoopeG's production DB server), reached over the Coopeg VPN.
    dbName: 'coredb-jasec',
    get suites() {
      const build = (process.env.JASEC_PROD_BUILD ?? '').trim().toLowerCase();
      return build.startsWith('test-build') ? ['jasec-'] : [];
    },
    note: 'JASEC production, LIVE and locked: nothing runs (only a test build, JASEC_PROD_BUILD=test-build-*, would open the jasec-* suites).',
  },

  'coopeg-sandbox': {
    baseUrl: 'https://coreui.coopeg.embrix.org/',
    graphqlUrl: 'https://transactional.coopeg.embrix.org/graphql',
    crmGatewayUrl: 'https://crm-gateway.coopegsbx.embrix.org',
    // No database configuration exists for this tenant; the one case that needs
    // one reports BLOCKED rather than running against somebody else's DB.
    suites: ['embrix-platform', 'coopeg-lifecycle'],
  },

  // CoopeG NetSuite reconciliation environment (EFT-88, Jeremy Hynes, from 2026-10-07).
  // Invoices and credit notes created here are synced to CoopeG's NetSuite
  // SANDBOX (8754760-sb1), so only the netsuite suite runs here. Its config DB
  // is NOT the coopegsbx3 snapshot shared with QA (Bug_006), hence no dbName.
  coopegsbx2: {
    baseUrl: 'https://core-ui.coopegsbx2.embrix.org/',
    graphqlUrl: 'https://service-transactional.coopegsbx2.embrix.org/graphql',
    crmGatewayUrl: 'https://crm-gateway.coopegsbx2.embrix.org',
    // eft106: EFT-106 escalation checks (client issues, process results, integration evidence).
    suites: ['netsuite', 'eft106'],
    note: 'NetSuite regression (EFT-88). Writes reach the CoopeG NetSuite sandbox; clock moves need NS_ALLOW_CLOCK=true.',
  },

  'congero-oci': {
    baseUrl: 'https://core-ui.congero.embrix.org/',
    graphqlUrl: 'https://service-transactional.congero.embrix.org/graphql',
    selfcareUrl: 'https://selfcare.congero.embrix.org/',
    // The CoopeG lifecycle suite is specific to that tenant's catalog and
    // provisioning, so it is not offered here.
    suites: ['embrix-platform'],
    note: 'Congero on OCI. Catalog and CCP time parameter were unset as of 2026-09-18, ' +
      'so most cases cannot pass yet.',
  },
};

/** Old names kept pointing somewhere sensible so existing profiles still work. */
const ALIASES: Record<string, string> = {
  // Same host as congero-oci — it was the AWS congero env before the move.
  'embrix-sandbox': 'congero-oci',
};

/** Retired tenants, named so the error can say what happened rather than "unknown". */
const RETIRED: Record<string, string> = {
  'congero-sandbox':
    'the nip.io demo box — reachable but has no catalog data and no CCP time parameter',
  sandbox: 'never a real tenant; it was the old default and resolved to CoopeG by accident',
};

export function tenantNames(): string[] {
  return Object.keys(TENANTS);
}

/**
 * Work out which tenant this run targets.
 *
 * TEST_ENV decides. EMBRIX_BASE_URL is still honoured — every existing profile
 * sets it — but only as a cross-check: if it names a different tenant than
 * TEST_ENV, that is the disagreement that caused ORD-1582 and the run stops.
 *
 * There is deliberately no fallback. Not knowing the tenant is a reason to
 * stop, never a reason to pick one.
 */
export function resolveTenant(): { name: string; tenant: Tenant } {
  const raw = (process.env.TEST_ENV ?? '').trim();
  const name = ALIASES[raw] ?? raw;
  const url = (process.env.EMBRIX_BASE_URL ?? '').trim();

  if (!name) {
    throw new Error(
      `TEST_ENV is not set. Choose one of: ${tenantNames().join(', ')}.\n` +
      `Example:  set -a; . ./.env.coopeg; set +a; npx playwright test --project=embrix-platform`,
    );
  }

  if (!TENANTS[name]) {
    const retired = RETIRED[raw];
    throw new Error(
      retired
        ? `TEST_ENV='${raw}' is retired — ${retired}.\nUse one of: ${tenantNames().join(', ')}.`
        : `TEST_ENV='${raw}' is not a known tenant.\nUse one of: ${tenantNames().join(', ')}.`,
    );
  }

  const tenant = TENANTS[name];

  // A URL that points somewhere else than TEST_ENV says is the dangerous case:
  // the run looks correctly configured and is not.
  if (url && !sameHost(url, tenant.baseUrl)) {
    const owner = Object.entries(TENANTS).find(([, t]) => sameHost(url, t.baseUrl))?.[0];
    throw new Error(
      `TEST_ENV and EMBRIX_BASE_URL disagree.\n` +
      `  TEST_ENV='${raw}'  ->  ${tenant.baseUrl}\n` +
      `  EMBRIX_BASE_URL    ->  ${url}${owner ? `  (that is '${owner}')` : ''}\n` +
      `Set them to the same tenant, or drop EMBRIX_BASE_URL and let TEST_ENV decide.`,
    );
  }

  assertDbMatchesTenant(name, process.env.DB_NAME);

  return { name, tenant };
}

/**
 * Refuse a database that belongs to a different tenant than TEST_ENV.
 *
 * The URLs are derived from TEST_ENV, but every DB helper connects to DB_NAME
 * straight from .env. So `TEST_ENV=jasec-dev` with `DB_NAME=coredb-jasec-preprod`
 * drove dev's UI while seeding and cleaning up preprod's database - the
 * ORD-1582 class of mistake, one layer down.
 *
 * An empty DB_NAME is not checked: the DB helpers already refuse to connect
 * without one. A tenant with no `dbName` accepts any database that is not
 * another registered tenant's.
 */
export function assertDbMatchesTenant(tenantName: string, dbName: string | undefined): void {
  const db = (dbName ?? '').trim();
  if (!db) return;
  const tenant = TENANTS[tenantName];
  if (!tenant) return; // resolveTenant already reported this

  const owner = Object.entries(TENANTS).find(([, t]) => t.dbName === db)?.[0];
  const wrong = tenant.dbName ? db !== tenant.dbName : owner !== undefined && owner !== tenantName;
  if (wrong) {
    throw new Error(
      `TEST_ENV and DB_NAME disagree.\n` +
      `  TEST_ENV='${tenantName}'  ->  ${tenant.dbName ?? '(no database for this tenant)'}\n` +
      `  DB_NAME              ->  ${db}${owner ? `  (that is '${owner}')` : ''}\n` +
      `Point DB_NAME at the same tenant (switch-env.ps1), or unset it.`,
    );
  }
}

/**
 * Refuse a suite that does not belong to this tenant — running the JASEC
 * billing specs against CoopeG, say. Projects are matched by prefix, so a new
 * `jasec-anything` project is covered without touching this file.
 */
export function assertSuiteAllowed(projectName: string, tenantName: string): void {
  const tenant = TENANTS[tenantName];
  if (!tenant) return; // resolveTenant already reported this

  if (!isSuiteAllowed(projectName, tenantName)) {
    const allowed = Object.entries(TENANTS)
      .filter(([, t]) => t.suites.some(p => suiteMatches(p, projectName)))
      .map(([n]) => n);
    throw new Error(
      `Project '${projectName}' is not valid against tenant '${tenantName}'.\n` +
      (allowed.length
        ? `  Run it against: ${allowed.join(', ')}\n`
        : `  No tenant declares this suite.\n`) +
      `  '${tenantName}' accepts: ${tenant.suites.join(', ')}`,
    );
  }
}

/** The non-throwing form of assertSuiteAllowed, for filtering the project list. */
export function isSuiteAllowed(projectName: string, tenantName: string): boolean {
  const tenant = TENANTS[tenantName];
  // A LOCKED tenant (no suites - JASEC prod's customer build) gets nothing that logs in or touches it: of the
  // tenant-agnostic projects only `unit` (pure helper logic, no browser, no network) stays.
  if (TENANT_AGNOSTIC.includes(projectName)) return projectName === 'unit' || !tenant || tenant.suites.length > 0;
  if (!tenant) return false;
  return tenant.suites.some(p => suiteMatches(p, projectName));
}

/** `*` = any, `name$` = exactly that project, otherwise a prefix. */
function suiteMatches(pattern: string, projectName: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('$')) return projectName === pattern.slice(0, -1);
  return projectName.startsWith(pattern);
}

/**
 * Every project named on a Playwright command line, in both forms Playwright
 * accepts: `--project=X` and `--project X`, repeated as often as given.
 */
export function requestedProjects(argv: string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const eq = /^--project=(.+)$/.exec(argv[i]);
    if (eq) names.push(eq[1].trim());
    else if (argv[i] === '--project' && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      names.push(argv[++i].trim());
    }
  }
  return names;
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}
