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
| JASEC prepaid | JASEC dev, preprod, dev on OCI | specs in `tests/regression/jasec/`. Onboarding guide, Parts 6–7 |
| CoopeG ↔ NetSuite | coopegsbx2 | `ns.ps1`, `ns-cycle.ps1`, `netsuite-suite/`. Onboarding guide, Part 8, and `NETSUITE.md` |
| Embrix platform | congero-oci | `tests/regression/embrixPlatform/`. Onboarding guide, Part 9 |

## Folder map

| Folder | What |
|---|---|
| `tests/` | the specs, one folder per track |
| `pages/` | page objects (one class per screen) |
| `fixtures/` | what Playwright prepares for each test (login, page objects, the clock) |
| `helpers/` | database, API, mailbox and other helpers |
| `config/tenants.ts` | the tenants and their web addresses |
| `netsuite-suite/` | NetSuite client file, tools and runbook |
| `docs/` | the onboarding guide and conventions (`PLAYWRIGHT_CONVENTIONS.md`) |

Settings files (`.env.*`) hold your own credentials and are never committed. `.env.example` and
`.env.coopegsbx2.example` list the keys.
