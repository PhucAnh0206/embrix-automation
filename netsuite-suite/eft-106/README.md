# EFT-106 escalation results (coopegsbx2)

Plan, coverage and what is still needed: `docs\NetSuite\EFT-106-COVERAGE.md`.

| File | Ticket | What |
|---|---|---|
| `EFT-107-client-issues.csv` | EFT-107 | The 5 client-reported issues: validation result, what was checked, result, evidence, what is needed to close |
| `EFT-108-process-results.csv` | EFT-108 | The 9 business processes: status, what was tested, cases and results (from the client CSV), open points, screenshots |
| `EFT-109-integration-evidence.csv` | EFT-109 | The 5 integrations: status, what was checked, result, evidence, what is needed |
| `results.json` | – | Latest verdict per check (written by the specs) |
| `evidence\<check>.json` | – | Request / answer pairs per check (tokens, passwords and secrets masked) |
| `evidence\<check>-*.png` | – | Screenshots per check (latest run): Core UI screens (order, Services, Bills, Credit/Debit Notes, Customer Activity with request and answer) and the NetSuite sandbox search. None of PortaOne activity or MOTV's session login (they show tokens and passwords) |
| `..\results\NetSuite_sandbox_documents.csv` + `..\evidence\netsuite-sandbox\` | regression | Every invoice / credit note the regression cases cite, looked up in the NetSuite sandbox (found once, same amount), with screenshots |

Specs (`automation\embrix-automation\tests\coopeg\tickets\eft-106\`, project `eft106`; VPN on for the database reads):

| Spec | Checks | Creates |
|---|---|---|
| `eft107-client-issues.spec.ts` | EFT107-I1…I5 | one QA contract (I1–I3), one manual invoice on 208886 (I5, sent to the NetSuite sandbox) |
| `eft109-integrations.spec.ts` | EFT109-NETSUITE / COOPEWEB / NOKIA / MOTV / PORTAONE | nothing (activity log since `EFT_SINCE`, NetSuite sandbox search) |
| `eft108-processes.spec.ts` | EFT108-BILLING, -DISCONNECTION, -CREDIT-NOTES, -CONTRACT-CREATION, -PLAN-CHANGES, -PAYMENTS | nothing: screenshots of the documents the regression cases cite |
| `eft108-payments-explore.spec.ts` | EFT108-PAYMENTS-CURRENT ("Recorded": under / over / group payment as Embrix handles them today, no rule yet) | four manual invoices on 208886 and three applyPayment calls |
| `eft108-network.spec.ts` | EFT108-PROVISIONING, -TV, -VOIP (-RELOCATION kept, out of scope) | nothing until the equipment settings are given (records "Blocked"); then one QA contract provisioned in NOKIA (+ MOTV / PortaOne) |

```powershell
cd D:\Dev\products\Embrix\automation\embrix-automation
$env:EMBRIX_ENV_FILE='.env.coopegsbx2'
npx playwright test --project=eft106 tests/coopeg/tickets/eft-106/eft107-client-issues.spec.ts tests/coopeg/tickets/eft-106/eft109-integrations.spec.ts tests/coopeg/tickets/eft-106/eft108-processes.spec.ts --reporter=line
npx playwright test --project=dev tests/coopeg/netsuite-actions/ns-sandbox-documents.spec.ts --reporter=line   # regression documents in the NetSuite sandbox
node ..\..\test-cases\netsuite\tools\eft106-report.js                                       # rebuild the three CSVs
```
- EFT-108 statuses come from the client CSV: rerun the process cases with `ns.ps1` / `ns-cycle.ps1` (runbook `docs\NetSuite\NEXT-RUN.md`) before rebuilding.
- I4 / NOKIA judge NOKIA's own answers since the current database era (`EFT_SINCE`, default 1209397); after a real provisioning run, set `EFT_SINCE` to its first activity id.
- Network run (`eft108-network.spec.ts`, one environment at a time: this environment and the Demo Sandbox share the NOKIA test system). Test ONT: `ALCLB3D94488 / G-2425G-B` (NOKIA refuses position 1-1-1-1-8, waiting for Coope; retest steps in `docs\NetSuite\NEXT-RUN.md` §9):
  `$env:EFT_ONT='<serial>'; $env:EFT_ONT_MODEL='<model>'; $env:EFT_ONT_CLEARED='true'; $env:EFT_GO='true'`,
  plus `EFT_TV='true'` (plan BDL_INT_200MBPS_TV, QA e-mail on the contract; `EFT_EMAIL` / `EFT_PHONE` override it if MOTV refuses ours. MOTV uses the contract number as the viewer login: no TV box id),
  and `EFT_DID='<number from the PortaOne inventory>'`.
- Judge an earlier run's contract without sending anything: `EFT_ACCOUNT='<account>'`; send its failed order again the agent's way (Order detail > Submit order): add `EFT_RESUBMIT='true'` (today this only re-checks NOKIA). A failed order keeps the ONT; before a fresh run release it: `node ..\..\test-cases\netsuite\tools\release-device.js <order> <serial>` (QA orders only, backup in `evidence\schedule-backups`). Last failed order holding ALCLB3D94488: `QA-ANH-NS-R2-10261545-E108-O`.
- EFT-110 (credit notes): `npx playwright test --project=dev tests/coopeg/netsuite-actions/ns-credit-open.spec.ts` (read only): the three EFT-86 credit-note PDFs (created before the fix; regeneration not needed, so EFT110-HIST-PDF is informational) and "Factura Referencia" on stamped PDFs (EFT110-HIST-PDF, EFT110-REF).
