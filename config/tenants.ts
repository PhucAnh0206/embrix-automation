/**
 * The tenant registry — one place that says which environments exist, where
 * they live, and which suites may run against them.
 *
 * WHY THIS EXISTS. Suite and tenant used to be independent: `--project` chose
 * the specs, a `.env` file chose the target, and nothing checked they agreed.
 * With 21 projects and 6 profiles that is 126 combinations, of which about 8
 * are real. Worse, the old resolution fell back to a LIVE tenant when it could
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
  /** Database for the few specs that read or clean up directly. */
  dbName?: string;
  /**
   * Playwright projects allowed against this tenant, by prefix.
   * `*` means any — used only for tenant-agnostic projects like `setup`.
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
    selfcareUrl: 'https://selfcare-ui.jasec-preprod.embrix.org/',
    crmGatewayUrl: 'https://crm-gateway.jasec-preprod.embrix.org',
    dbName: 'coredb-jasec-preprod',
    suites: ['jasec-'],
  },

  'coopeg-sandbox': {
    baseUrl: 'https://coreui.coopeg.embrix.org/',
    graphqlUrl: 'https://transactional.coopeg.embrix.org/graphql',
    crmGatewayUrl: 'https://crm-gateway.coopegsbx.embrix.org',
    // No database configuration exists for this tenant; the one case that needs
    // one reports BLOCKED rather than running against somebody else's DB.
    suites: ['embrix-platform', 'coopeg-lifecycle'],
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

  return { name, tenant };
}

/**
 * Refuse a suite that does not belong to this tenant — running the JASEC
 * billing specs against CoopeG, say. Projects are matched by prefix, so a new
 * `jasec-anything` project is covered without touching this file.
 */
export function assertSuiteAllowed(projectName: string, tenantName: string): void {
  if (TENANT_AGNOSTIC.includes(projectName)) return;

  const tenant = TENANTS[tenantName];
  if (!tenant) return; // resolveTenant already reported this

  const ok = tenant.suites.some(p => p === '*' || projectName.startsWith(p));
  if (!ok) {
    const allowed = Object.entries(TENANTS)
      .filter(([, t]) => t.suites.some(p => p === '*' || projectName.startsWith(p)))
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

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}
