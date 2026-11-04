# embrix-automation

Playwright + TypeScript test automation for **Embrix**: JASEC prepaid electricity, the CoopeG ↔ NetSuite integration
and the Embrix platform regression.

**Start here: [docs/PLAYWRIGHT-AUTOMATION-ONBOARDING.md](docs/PLAYWRIGHT-AUTOMATION-ONBOARDING.md).** It covers setup,
Playwright basics, how to run one case, one functionality or everything, and a part for each tenant.

## Quick start

```powershell
git clone https://github.com/PhucAnh0206/embrix-automation.git
cd embrix-automation
npm ci
npx playwright install chromium
# create your settings file from .env.example (see the onboarding guide, Part 3), then:
.\switch-env.ps1 preprod
npx playwright test --project=setup --project=unit
npx playwright test --ui
```

## Tracks

| Track | Tenants | Where |
|---|---|---|
| JASEC prepaid | JASEC dev, preprod, dev on OCI | specs in `tests/jasec/`. Onboarding guide, Parts 6–7 |
| CoopeG ↔ NetSuite | coopegsbx2 | `ns.ps1`, `ns-cycle.ps1`, `netsuite-suite/`. Onboarding guide, Part 8, and `NETSUITE.md` |
| Embrix platform | congero-oci | `tests/embrix-platform/`. Onboarding guide, Part 9 |

## Folder map

| Folder | What |
|---|---|
| `tests/jasec/` | JASEC prepaid specs, one folder per area (`account`, `top-up`, `billing`, `notification`, `provisioning`, ...); `tickets/` = per-ticket runs |
| `tests/coopeg/` | CoopeG: `lifecycle/`, `netsuite/` (regression), `netsuite-actions/` (screen runners used by `ns-cycle.ps1`), `tickets/eft-106/` |
| `tests/embrix-platform/` | the Embrix platform suite |
| `tests/data/` | input data for the specs |
| `tests/unit/`, `tests/smoke/` | helper unit tests and smoke checks |
| `pages/` | page objects (one class per screen) |
| `fixtures/` | what Playwright prepares for each test (login, page objects, the clock) |
| `helpers/` | database, API, mailbox and other helpers |
| `config/tenants.ts` | the tenants and their web addresses |
| `netsuite-suite/` | NetSuite client file, tools and runbook |
| `docs/` | the onboarding guide and conventions (`PLAYWRIGHT_CONVENTIONS.md`) |

Settings files (`.env.*`) hold your own credentials and are never committed. `.env.example` and
`.env.coopegsbx2.example` list the keys.
