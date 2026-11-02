import * as path from 'path';

/**
 * Per-tenant home for files a run leaves behind for a later step (handoffs, restore plans, evidence).
 *
 * WHY. Several tenants run from this one repo, often at the same time (dev + preprod side by side,
 * prod, jasec-oci-dev, NetSuite). Handoff files used to live at fixed paths such as
 * artifacts/jasec-latest-meter.json or artifacts/billing-run-invoices.json, so a preprod run could
 * overwrite dev's handoff, or read it - and account ids collide across tenants (ACT-1000xx exists on
 * preprod and on jasec-oci-dev), so nothing looked wrong. Everything a later step reads back now
 * lives under artifacts/<TEST_ENV>/ (2026-10-14).
 *
 * TEST_ENV is set by playwright.config.ts before any spec loads; outside a run it falls back to
 * 'no-tenant' rather than guessing one.
 */
export function tenantKey(): string {
  return (process.env.TEST_ENV ?? '').trim() || 'no-tenant';
}

/** artifacts/<TEST_ENV>/<...parts> under the repo root (the Playwright cwd). */
export function tenantArtifactPath(...parts: string[]): string {
  return path.join(process.cwd(), 'artifacts', tenantKey(), ...parts);
}
