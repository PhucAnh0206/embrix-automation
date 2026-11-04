# NetSuite regression (coopegsbx2): run the official cases

Automation of the Embrix ↔ Oracle NetSuite integration for CoopeGuanacaste, on the NetSuite test environment **coopegsbx2** (`core-ui.coopegsbx2.embrix.org`) and Coope's NetSuite sandbox. Every case in the client file `netsuite-suite\NetSuite_Regression_TestSuite - NetSuite_Regression_TestSuit.csv` is automated here.

## 1. Set up (once)
Windows, PowerShell, Node.js 20+.
```powershell
git clone https://github.com/PhucAnh0206/embrix-automation.git
cd embrix-automation
npm ci
npx playwright install chromium
```
Two settings files, never committed (ask the QA lead for the values):

| File | From | Holds |
|---|---|---|
| `.env.coopegsbx2` | copy `.env.coopegsbx2.example` | Core UI QA login, DB, QA mailbox, NetSuite sandbox tester account |
| `netsuite-suite\tools\.pg-coopegsbx-dev.json` | copy `netsuite-suite\tools\pg-config.example.json` | DB of the environment (read-only checks, DB steps) |

**VPN:** the dev/preprod VPN must be on for the cases that read the database and for the billing cycle. The Core UI works with it on.

## 2. Before every run
```powershell
node netsuite-suite\tools\clock.js get         # the environment's date; others move it
$env:NS_BASELINE = '<that date>'               # every runner puts the clock back here
```
- **One person runs at a time** on coopegsbx2: the clock, the Daily Schedules and the test ONTs belong to the whole environment. Say in the team chat when you start and stop.
- Never use ONT `ALCLB3A97FBA` (the CoopeG team's). The runners refuse it.

## 3. Run
**Automated cases** (`ns.ps1`, one case, a list, or an area):
```powershell
.\scripts\netsuite\ns.ps1 smoke                                  # quick health check: settings, NetSuite reachable
.\scripts\netsuite\ns.ps1 INV-003 INV-018 PAY-001                # chosen cases
.\scripts\netsuite\ns.ps1 billing                                # an area: smoke, billing, customer, inbound, credits, screens, exempt, basics
.\scripts\netsuite\ns.ps1 INV-003 -Headed -SlowMo 300            # watch it in the browser
```
**Billing cycle on a new contract** (`ns-cycle.ps1`, about 45 minutes; provisions a contract, bills three months, collection, suspension, payment, reconnection, plan change, cancellation):
```powershell
.\scripts\netsuite\ns-cycle.ps1 full -Start <YYYY-MM-01> -CleanSchedules
```
Every case, its command and its prerequisites (credit windows, contracts, Coope's test contracts): the runbook **`netsuite-suite\docs\NEXT-RUN.md`**, section 6.

## 4. Results
- `netsuite-suite\results\NetSuite_Regression_TestSuite_R2_<date>.csv`: the client file with this run's Actual Result and Status per case.
- `output\test-results\` and `netsuite-suite\evidence\`: screenshots and what was sent / received per case.
- The client file itself (`netsuite-suite\NetSuite_Regression_TestSuite…csv`) holds the latest official results; it is updated by QA, not by the runs.

## 5. Rules
- Only QA test contracts and the team account 208886 are changed. Coope's contracts 798169 / 244822 / 798166 only for the documents NetSuite must accept.
- The NetSuite sandbox is **view only**: the automation searches documents, never edits.
- Daily Schedules bill every account due on that date.
- Credentials stay in the two settings files above.

## Folder map
| Path | What |
|---|---|
| `tests\coopeg\netsuite\` | The regression specs (ns-00 … ns-08) |
| `tests\coopeg\netsuite-actions\ns-*.spec.ts` | Screen runners used by `ns-cycle.ps1` and the extra checks (provisioning, billing run, Bills actions, NetSuite sandbox) |
| `tests\coopeg\tickets\eft-106\` | Client escalation checks (EFT-107 / 108 / 109) |
| `helpers\netsuite\` | Shared NetSuite code (API, screens, data, records) |
| `netsuite-suite\` | Client file, internal checks, tools, runbook |
| `ns.ps1`, `ns-cycle.ps1` | Runners |
| `ns-demo.ps1` | Business demo (not regression): `netsuite-suite\docs\DEMO.md` |
