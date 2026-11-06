# NetSuite regression runbook (coopegsbx2)

How to run every case of the client file again, and how to retest each pending fix (§9). Build under test: **feature/netsuite** .
Results: the client file `netsuite-suite\NetSuite_Regression_TestSuite - NetSuite_Regression_TestSuit.csv`.

Paths below: **suite** = the root of this repo, **tools** = `netsuite-suite\tools`. Playwright commands run from the suite with `
## 0. Before you start
- Access: Core UI login in the suite's `.env.coopegsbx2`; DB config `tools\.pg-coopegsbx-dev.json` (git-ignored) with the dev/preprod **VPN on** (DB steps, ENV-001/002, checks). The UI runs fine with the VPN on.
- Clock: others move it (the team, Coope). Read it and make it the baseline every tool and runner returns to:
  ```powershell
  node tools\clock.js get            # e.g. 2027-03-15
  $env:NS_BASELINE='2027-03-15'      # tools (ns-lib.js) and ns-cycle.ps1 put the clock back here (default 2027-01-01)
  ```
  If a run is killed, set it back by hand: `node tools\clock.js set $env:NS_BASELINE`.
  NetSuite refuses documents dated in a period that is not open (2028 to 2030 open on 31 Oct): if the clock moves into a year that is not open, date tool invoices in an open year (`invoice-and-credit.js <acc> 2028-…`). The screen cases keep the last invoice NetSuite accepted.
- Settings that pods can overwrite on restart: check `daysBilledAfterSuspension` = 11, `fullCycleOnSameCycleReconnection` = false, `billUsedDaysOnCancel` = true, `financeSyncPrepaidInvoices` = true before billing runs (`ro-query.js` on `core_config.ccp_properties`).
- Provisioning: the cycle (`ns-cycle.ps1`, DB step, no real NOKIA) uses ONT `ALCLB3D9363D / G-2425G-B` (one contract at a time; cancel the previous one). Real NOKIA / MOTV / PortaOne runs: `tests/coopeg/tickets/eft-106/eft108-network.spec.ts` with ONT `ALCLB3D94488 / G-2425G-B` (§9); this environment and the Demo Sandbox share the NOKIA test system, so one environment at a time. **Never the CoopeG team's `ALCLB3A97FBA`**.
- Free to test any time (clock moves included); the QA lead says when to stop. Long background runs get killed by memory pressure: run one block at a time.

## 1. Build check (read-only, ~10 min)
```powershell
$env:NS_PG='coopegsbx-dev'
node tools\ro-query.js "select count(*) from core_engine.finance_sync_outbox"                               # NetSuite queue exists
node tools\ro-query.js "select * from core_config.ccp_properties where property ilike '%reason%'"            # undoInvoiceCreditReason set (INV-018)
cd <suite>; .\scripts\netsuite\ns.ps1 smoke; .\scripts\netsuite\ns.ps1 ENV-001 ENV-002 AUTH-001
```
Stop and report if services, settings or NetSuite answers fail.

## 2. Automated suite (`ns.ps1`)
```powershell
cd <suite>
.\scripts\netsuite\ns.ps1 smoke billing customer inbound screens exempt
.\scripts\netsuite\ns.ps1 CRM-003 INV-004 API-001 AR-002 AR-006 RPT-005 MAP-005 MAP-008 MAP-009 MAP-011 MAP-012 MAP-013 INV-007 INV-008 ENG-007-01 ENG-007-03 '~RPT-001/002:'
# credit window: a date after the latest credit note of 208886 / 798169 / 244822 (query in §4), not in September 2027
$env:NS_REUSE_RUN='10121024'
node tools\clock.js set <credit window>
.\scripts\netsuite\ns.ps1 credits INV-014 CRN-002 CRN-005 CRN-006 CRN-007 CRN-008 CRN-010 ENG-006-02 ENG-006-03 ADJ-001 ADJ-002
node tools\clock.js set $env:NS_BASELINE
$env:NS_ALLOW_CLOCK='true'; .\scripts\netsuite\ns.ps1 INV-010; $env:NS_ALLOW_CLOCK=$null
```
- Contract cases (MAP-005/008/009/011/012, INV-007, ENG-007-01..03) use QA contracts: `$env:NS_REUSE_RUN='10121024'` while the 10-12 contracts exist, or `$env:NS_CONTRACT_E1='<id>'` (also `N1`, `N2`, `I1`) for another QA contract. Never point `NS_CONTRACT_*` at a Coope contract: the exemption cases change and then clear the contract's exemption.
- Credit runs need `NS_REUSE_RUN=10121024` (ENG-006-03 / CRN-007 use the 10-12 contract N2; without it the spec creates a new contract with no invoice).
- The spec tests named CRM-005 / CRM-006 in `ns-02-crm-contracts.spec.ts` are the older partyId checks, not the client file's CRM-005 / 006 (those come from EFT107-I1..I3, §6).

## 3. Provisioned-contract cycle (`ns-cycle.ps1`)
Whole cycle on one new contract, about 45 min:
```powershell
cd <suite>; .\scripts\netsuite\ns-cycle.ps1 full -Start <YYYY-MM-01> -CleanSchedules
```
`-Start` is the 1st of a month in an open NetSuite period; the run bills the next 3 months (M1, M2, M3). `-CleanSchedules` first deletes the old Daily Schedules from M1-01 to M3-02 (`clean-schedules.js`, at most 62 days per call, backup in `netsuite-suite\evidence\schedule-backups\`). Plans bill after the month: each invoice covers the month that ended. Steps and cases:

| Step (date) | What happens | Cases |
|---|---|---|
| provision N (Start) | contract through the Coopeweb API, provisioning order with the ONT, DB step + Submit order → ACTIVE | – |
| Suspend (Start+9), Resume (Start+19) | manual orders → SUSPENDED → ACTIVE; the month bills only the days of service | SUS-001 |
| schedule M1-01 | invoice for the start month (prorated from the start day), stamped, sent to NetSuite (test contract → "contract not found") | INV-002, REG-001 |
| schedule M1-18 / 19 / 21, finish SUSPEND, schedule M1-22 | due, reminder, suspension (SUSPEND order completed → SUSPENDED), notice to Coopeweb | REG-002, CAN-002 |
| pay (M1-24), finish RESUME | payment closes the invoice + collection, one RESUME order → ACTIVE | REG-002 |
| plan change (M1-26), finish MODIFY | IPTV Standard + TV added | CHG-001 |
| schedule M2-01 | invoice with the TV lines from the 26th | CHG-001, REG-001 |
| Cancel (M2-10) | subscription CLOSED | CAN-001 |
| schedule M3-01 | the 1st to the 9th billed; nothing after | CAN-001 |

Then `node tools\contract-state.js <account> --calls` shows every bill, invoice, credit and NetSuite call for the CSV.

Other contract types (one ONT: cancel each before the next):
```powershell
.\scripts\netsuite\ns-cycle.ps1 provision -Tag X -Date <date>      # no Party Id: invoice sent without customer → NetSuite error kept (MAP-007, ENG-007-02)
.\scripts\netsuite\ns-cycle.ps1 provision -Tag H -Date <date>      # PHC: department 135 / class 10 (MAP-003)
.\scripts\netsuite\ns-cycle.ps1 provision -Tag T -Date <date>      # Internet + TV (BDL_INT_200MBPS_TV + BDL_TV; TV row = MOTV, id = contract number)
.\scripts\netsuite\ns-cycle.ps1 provision -Tag B -Date <date>      # business (ENTERPRISE, BDL_INT_30MBPS_EMP); $env:NS_PROV_B_TYPE / NS_PROV_B_BUNDLE vary type / plan
.\scripts\netsuite\ns-cycle.ps1 discount -Account <account> -Date <date> -Offer DESC_CATALINA   # Modify > Add Discounts > Next > Billing Only > Create
.\scripts\netsuite\ns-cycle.ps1 schedule -Date <date>              # bill it (clean the date first if a COMPLETED / ERROR schedule exists)
node tools\contract-state.js <account> --calls
.\scripts\netsuite\ns-cycle.ps1 order -Account <account> -Kind Cancel -Date <date> -Expect CLOSED
```
Single steps: `provision`, `discount -Account -Date -Offer`, `schedule -Date` (retries once if no schedule was created), `order -Account -Kind Cancel|Suspend|Resume -Date -Expect`, `finish -Account -Date -Expect` (completes the open order: collection SUSPEND, RESUME after payment, MODIFY).

Suspended-line rules (UAT guide UAT-06..10): `.\scripts\netsuite\ns-cycle.ps1 suspended -Start <YYYY-MM-01> -CleanSchedules [-Account <acc>]` on a new contract: M0 suspend 10th / resume 20th (days of service), M1 collection cut on the 21st (days before the cut + 11 = full month), M2 fully suspended (nothing), M3 paid on the 10th (from the 10th), M4 cancelled on the 5th, M5 bills the 1st to the 4th. Read the bills with `node tools\contract-state.js <acc>` and the lines in `core_engine.invoice_summary` (the `discount` column holds discounts).
- Bill only through Daily Schedules. "Run pending bill" on one account leaves that period's regular bill pending (it could bill the period twice).
- A schedule Embrix created itself (collection dates) is PENDING: `schedule` processes it. A COMPLETED / ERROR one stops the step: `node tools\clean-schedules.js <date> <date> --go`.
- Submit order is only enabled when the clock equals the order's effective date (the steps do this).
- Documents dated in a closed or missing NetSuite period are refused ("No valid, open, tax period"); Coope's NetSuite admin opens periods.

## 4. Cases on contracts NetSuite knows (tools, clock restored)
| Case | Command | Expect |
|---|---|---|
| CRN-003, RET-002 | `node tools\invoice-and-credit.js 798169 <date>` | invoice SUCCESS; automatic intercompany credit with I_INTERDE tax code 7 + levies 5, applied to the invoice |
| CRN-011 | `node tools\invoice-and-credit.js 244822 <date> --line-credit 1000` | invoice Internet tax code 8; credit keeps tax code 8 (tax 80 on 1,000), applied |
| INV-018 | `.\scripts\netsuite\ns.ps1 INV-018`: a manual invoice on 208886 reaches NetSuite, then Bills > UNDO_MANUAL_INVOICE > SUBMIT (the agents' way since 31 Oct) | invoice kept, CLOSED by a full credit note incl. taxes ("NC - Anulación por refacturación"), stamped, sent applied |
| INV-001 | Coope contract 798166 (NetSuite customer 120998, bills on the 1st). A Daily Schedule takes its bills when it is created: `node tools\clean-schedules.js <date> <date> --go`, `.\scripts\netsuite\ns-cycle.ps1 schedule -Date <date>`, `node tools\contract-state.js 798166 --calls` | recurring invoice sent once, accepted (FA…) |
| CRN-006 (stamped reason) | `node tools\credit-note.js line 208886 <invoice> I_INT 500 WITHOUT_TAX "NC - Error en facturación" <date>` | tax code 5, tax 0, stamped, accepted |
| CRN-004 | `$env:NS_BULK_INVOICE='<invoice of 208886>'; $env:NS_BULK_DATE='<credit window>'; npx playwright test tests/coopeg/netsuite-actions/ns-bulk-adjustment.spec.ts --project=dev` (clock set and restored). By hand: Core UI > AR Operations > Bulk Adjustments > Upload; example file in `netsuite-suite\evidence\bulk\`, new file name each time | file 1 / 0 / 0 / 1, line COMPLETED, credit note SUCCESS in NetSuite |
| AR-006 | `$env:NS_AR006_ACCOUNT='<account>'; $env:NS_AR006_INVOICE='<invoice whose collection started after the current settings>'; .\scripts\netsuite\ns.ps1 AR-006`, clock before its next action. One grant per collection unit | SUCCESS, GRACE_PERIOD_REQUESTED, next action 5 days later |
| Re-send a credit note | `$env:NS_RESEND='<acc>:<CR-id>,...'; npx playwright test tests/coopeg/netsuite-actions/ns-resend-credit-notes.spec.ts --project=dev` (Credit/Debit Notes > SYNC_CREDIT_NOTE, only on a credit in ERROR); API: `node tools\credit-note.js resend <acc> <CR-id>` | sync SUCCESS, NC… |

`<date>` / credit window: after the contract's latest credit note, not in September 2027, in an open NetSuite period:
`node tools\ro-query.js "select accountid, max(notesdate) from core_engine.notes_unit where accountid in ('798169','244822','208886') group by 1"` (dates in UTC, +1 day locally). ENG-006-02 also credits 244822 (`NS_ENG00602_ACCOUNT` for another account). 244822's exemption runs to 2027-12-31.

## 5. NetSuite sandbox check (automated, view only)
`$env:NS_SB_FIND='FA…,NC…'; npx playwright test tests/coopeg/netsuite-actions/ns-sandbox-check.spec.ts --project=dev` signs in itself (session in `playwright/.auth/netsuite-sandbox.json`, account in the git-ignored `.env.coopegsbx2`) and looks up each document number: total, customer, date, status, amount, with screenshots. All regression documents: `tests/coopeg/netsuite-actions/ns-sandbox-documents.spec.ts` → `netsuite-suite\results\NetSuite_sandbox_documents.csv`. Avoid fresh logins (each may show the security-questions prompt, never answered); never Edit / Save in NetSuite.

## 6. Every case: how it runs
| Case(s) | How | Notes |
|---|---|---|
| CRM-001, CRM-003, CRM-004, AUTH-001, REG-003, INV-003, INV-005, INV-006, INV-009, MAP-001, MAP-002, MAP-004, MAP-006, AR-001, AR-002, PAY-001, API-001, RPT-001/002, RPT-005 | `ns.ps1` | §2 |
| CRM-005, CRM-006 | `tests/coopeg/tickets/eft-106/eft107-client-issues.spec.ts` (EFT107-I1..I3: order number kept; no plan or active service before connection) | `netsuite-suite\eft-106\README.md` |
| INV-007, INV-008, MAP-008, MAP-009, MAP-012, MAP-013 | `ns.ps1` with QA contracts | §2 |
| INV-010 | `ns.ps1` with `NS_ALLOW_CLOCK=true` | §2 |
| CRN-001, CRN-002, CRN-005..008, ENG-006-01, ADJ-001, ADJ-002 | `ns.ps1` in a credit window | §2 |
| AR-006 | `ns.ps1` | §4 |
| INV-004 | `tests/coopeg/netsuite-actions/ns-sync-invoice.spec.ts` on a prepaid electricity invoice | §9 (Bug_049) |
| INV-002, REG-001, REG-002, SUS-001, CHG-001, CAN-001, CAN-002 | `ns-cycle.ps1 full` | §3 |
| MAP-007 | `ns-cycle.ps1 provision -Tag X` + schedule | §3 |
| MAP-003 | `ns-cycle.ps1 provision -Tag H` + schedule | §3 |
| CRN-003, RET-002, CRN-011 | tools on 798169 / 244822 | §4 |
| INV-018 | `ns.ps1` (Bills > Undo) | §4 |
| INV-001, CRN-004 | 798166 + Daily Schedule / Bulk Adjustments upload | §4 |
| ACC-001..003 | `ro-query.js` on `core_config.config_job_list` (CJ-12 has no EBS_EXTRACT) and `core_engine.job_schedule_list` (no EBS_EXTRACT after 2027-10-02) | |
| PAY-002..005 | `tests/coopeg/tickets/eft-106/eft108-payments-explore.spec.ts` (under / over / group payment on 208886) | Need confirmation (Coope) |
| NET-001..004 | `tests/coopeg/tickets/eft-106/eft108-network.spec.ts` | Blocked: §9 |
| Internal checks (ENV-*, ENG-007-*, ENG-006-02/03, MAP-005/011, AR-003/004, RPT-003, RET-003, EDGE-*) | `ns.ps1` / Dev, per `internal-checks.csv` | not in the client file |

## 7. Tools (`netsuite-suite\tools`)
| Tool | Does | Writes |
|---|---|---|
| `clock.js get / set <date>` | CCP clock | clock |
| `ro-query.js "<select>"` | read-only SQL (`NS_PG=coopegsbx-dev`) | – |
| `contract-state.js <acc> [--calls]` | subscription, orders, bills, invoices, collection, credits, NetSuite calls | – |
| `order-check.js open / sub / schedule / invoice` | lookups for `ns-cycle.ps1` | – |
| `schedule-check.js <date>` / `collection-state.js` | one Daily Schedule's results / collection of the QA contracts | – |
| `complete-order.js <orderId>` | DB step of a QA order (the CoopeG team's way) | DB, QA orders only |
| `release-device.js <orderId> <serial>` | free an ONT held by a failed (PROVISIONING_ERROR) or stuck (PROVISIONING_INITIATED) QA order: row renamed `<serial>-RELEASED-<MMDD>`, backup first | DB, QA orders only |
| `clean-schedules.js <from> <to> [--go]` | delete old Daily Schedules (≤ 62 days per call), backup first | DB, shared |
| `pay-invoice.js <acc> <invoice> <date> [amount]` | payment through applyPayment (the call NetSuite uses); full amount due unless given | payment |
| `plan-change.js <acc> <date> [suffix]` | MODIFY order through the Coopeweb API | order, QA only |
| `invoice-and-credit.js <acc> <date> [--line-credit n] [--item <svc>:<item>]` | manual invoice (+ line credit), prints credits and NetSuite calls | invoice / credit |
| `undo-invoice.js <acc> <invoice> <date>` | undo of an invoice | credit note |
| `credit-note.js resend / line / show` | re-send a credit note; line credit with a chosen tax rule and reason, with exact times | credit note |
| `eft106-report.js` | rebuilds the EFT-107 / 108 / 109 CSVs | files |

UI runners (suite `tests\coopeg\netsuite-actions`, `--project=dev`): `ns-provision`, `ns-submit-order`, `ns-cancel-order` (Cancel / Suspend / Resume), `ns-billing-run`, `ns-discount-order` (`NS_DISC_ACCOUNT`, `NS_DISC_OFFER`, `NS_DISC_GO`) — `ns-cycle.ps1` drives them; `ns-sync-invoice` (`NS_SYNC_INVOICE=<acc>:<invoice>`, `NS_SYNC_SHOT_ONLY`), `ns-manual-invoice` (`NS_MI_ACCOUNT`, `NS_MI_LINE=<svc>:<item>:<price>`), `ns-credit-open` (EFT-110), `ns-sandbox-check`, `ns-sandbox-documents`, `ns-bill-action` (`NS_BILL=<acc>:<invoice>`, `NS_BILL_ACTION=UNDO_MANUAL_INVOICE | EXTEND_DUE_DATE`, `NS_BILL_DATE`, `NS_BILL_GO=true`: Bills actions offered, form, submit; INV-018 on screen, Bills due-date extension).

## 8. Report
Client CSV: latest result only, business wording, each row states the rule and the result (no "as agreed", internal names, run labels, local bug ids or root causes). Statuses Pass / Fail / Blocked / Need confirmation. Evidence to the client: screenshots only (JSON is internal). Messages: I-voice, inside a ```text block, dev and business points sent separately. NetSuite numbers (FA… / NC…) only after the sandbox check (§5).

## 9. Retest checklist when fixes land
| Pending item (owner) | Retest | Pass when | Then update |
|---|---|---|---|
| Bug_049 prepaid electricity stopped (dev) | Check `financeSyncPrepaidInvoices` = true; find a stamped, unsent prepaid invoice (`ro-query.js` on 146195), then `$env:NS_SYNC_INVOICE='146195:<invoice>'; npx playwright test tests/coopeg/netsuite-actions/ns-sync-invoice.spec.ts --project=dev`; §5 lookup. Once the team says how a new prepaid invoice is created: create one (`ns-manual-invoice.spec.ts` with `NS_MI_ACCOUNT=146195`, or their method) and send it | NetSuite SUCCESS with an FA… number; the public lighting line I-100005 carries the tax code Coope gives; found once in the sandbox | INV-004 → Pass; bugs.md, STATUS.md |
| Overpayment rule (Coope, then dev if it changes) | `tests/coopeg/tickets/eft-106/eft108-payments-explore.spec.ts` (four manual invoices on 208886, under / over / group payment) | Excess kept as a credit for the next invoice (Coope's answer) and how NetSuite learns of it; group payment as Coope confirms | PAY-002..005 |
| A free test ONT (other test team / Coope; NOKIA itself works since 31 Oct) | ALCLB3D94488 is on the other team's 798696: once they cancel it (or with another free ONT), check nothing else holds it (`ro-query.js` on `core_engine.service_provision` / `core_oms.order_service_provisions`), confirm nothing runs on the Demo Sandbox, then `eft108-network.spec.ts` with `EFT_ONT='ALCLB3D94488'`, `EFT_ONT_MODEL='G-2425G-B'`, `EFT_ONT_CLEARED='true'`, `EFT_GO='true'`, `EFT_TV='true'` | NOKIA configures the ONT, order COMPLETED; MOTV creates the viewer profile; then suspension / reconnection / disconnection reach NOKIA | NET-001/002/004, EFT-107 #4, EFT-109 NOKIA / MOTV; `eft106-report.js` |
| MOTV e-mail / phone mapping (added by the team) | Same run with `EFT_TV='true'`; in Customer Activity the `CREATE_STB_PROFILE_ORDER` request carries the contract's e-mail and phone, not `--email--` / `--number--`; also the order's UPDATE_WORK_ORDER answers "registrados correctamente" (EFT-116) | MOTV status 1 and the viewer profile created; code 24 again → Coope (test user rights) | NET-002, EFT-109 MOTV / CoopeWeb |
| PortaOne access + test number (Coope) | Same run with `EFT_DID='<number>'`, after Coope allows 50.16.147.102 and 54.86.10.32 (EFT-118) to voip.coopeguanacaste.cr:443 | CREATE_CUSTOMER / CREATE_ACCOUNT / UPDATE_DID answered | NET-003, EFT-109 PortaOne |
| Failed provisioning order retry (dev answer) | Order detail > Submit order / Cancel on a PROVISIONING_ERROR QA order | Retry or cancel possible on screen, ONT freed without the DB step | bugs.md |

After any retest: rerun the cases of the same area (§6), rebuild the EFT CSVs (`node tools\eft106-report.js`), and update the client CSV to the current state.

**Side checks** (low priority, not NetSuite defects; from Coope's production billing run of 1 Nov 2026). Run once the November release reaches coopegsbx2, when there is time:
- An invoice whose only line is the Fondo Mutualidad (660.00, no IVA) is stamped and reaches NetSuite with tax code 5 (production: the stamping provider refused such invoices; fix in the November release).
- An unreadable answer from the stamping provider (JARS) never leaves an invoice issued in Hacienda but cancelled in Embrix, so missing from NetSuite (fix in the November release; hard to reproduce, check if it happens).
- A plan change ordered in one month and completed in the next: the expected start date of the new plan depends on Coope's answer to the November release question (request date, as today, or the day the change is completed, the team's recommendation). Either way no invoice goes negative (production: 173319 at -479,289.12 on the 1 Oct run; 14 contracts billed the new plan only from the 1st on the 1 Nov run).
- Partial exemption (84.62 %): if Coope accepts computing the IVA from the points left, a 10,000.00 line carries 200.00 IVA instead of 199.94; MAP-008's amounts change and NetSuite must get the same tax as the invoice.

## 10. Another machine, or a demo
**What a teammate needs** (both repos are private; give read access, never publish them):
- The automation repo and this workspace's `test-cases\netsuite` folder: the runners find it two levels up (`<workspace>\automation\embrix-automation`), or set `$env:NS_SUITE_DIR` to its path. The specs write results and evidence there.
- Windows PowerShell (the runners), Node + `npm ci` + `npx playwright install chromium`.
- `.env.coopegsbx2` from `.env.coopegsbx2.example` (Core UI QA login, DB, QA mailbox, NetSuite sandbox account) and `tools\.pg-coopegsbx-dev.json` from `tools\pg-config.example.json`. Credentials are handed over privately, never in chat or git. The NetSuite sandbox account is Coope's shared tester account: share it only with Coope's OK; without it, the sandbox checks (§5) are skipped.
- The dev/preprod VPN for the DB steps and checks.
- **One runner at a time on coopegsbx2.** The run lock (`.run-lock.coopegsbx2`) is per machine, but the clock, Daily Schedules and the shared ONT are per environment: agree who runs.

**Demo for business stakeholders:** `docs\NetSuite\DEMO.md`: `cd <suite>; .\scripts\netsuite\ns-demo.ps1` (menu; invoice to NetSuite, due-date extension, payment from NetSuite, void by credit note; about 6 minutes for all four, browser visible with captions; no VPN).
Longer, if asked: `.\scripts\netsuite\ns-cycle.ps1 full -Start <YYYY-MM-01> -CleanSchedules` (about 45 min: provision, bill, collect, cut, pay, reconnect, plan change, cancel; bills every due account on the dates it runs). The results land in `netsuite-suite\results\` (CSV per run) and the screenshots in `evidence\`.

## Safety
Clock back to `NS_BASELINE` · never the CoopeG team's ONT · one environment at a time on the shared NOKIA test system · DB writes only through `complete-order.js` / `release-device.js` (QA orders) and `clean-schedules.js` (backup first) · Coope contracts only 798169 / 244822 / 798166 and team account 208886 · NetSuite sandbox view-only · never print NetSuite OAuth values or other systems' credentials from Customer Activity (no screenshots of PortaOne activity, MOTV SESSION_LOGIN, Coopeweb GET_AUTHORIZATION_TOKEN) · never show the engine bulk_processing / adjustment_upload files unfiltered (DB password) · EMAIL_INVOICE only to the QA mailbox.
