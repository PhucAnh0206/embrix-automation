# NetSuite — expected values ("oracles")

The suite cites `oracle-01` … `oracle-05`. The original files were lost with the old laptop (2026-10). This file rebuilds them from:
- the round-1 suite (`docs\NetSuite\NetSuite_Regression_TestSuite - NetSuite_Regression_TestSuite_coopegsbx2.csv`, run 10-07 → 10-09)
- Jeremy's handoff (`docs\NetSuite\Docs\netsuite_qa_developer_handoff.docx`, 2026-10-08)
- the architecture diagram (`docs\NetSuite\Docs\Embrix–NetSuite Integration Architecture.png`)
- the Teams thread (10-05 → 10-12)

Tags: `[CONFIRMED-R1]` = matched on the environment in round 1. `[CONFIRMED-DB]` = read from the coopegsbx3 snapshot DB on 10-12 (config / historical payloads; see Bug_006 about which DB the app uses). `[ASSUMPTION]` = derived, must be confirmed against Jira (ISP-217 / ISP-215 / ISP-242) or with Jeremy before it fails a test.

---

## oracle-01 — Mapping tables (department / class / location / taxCode / tipoFactura)

### Line of business → department / class / location  (ISP-215, ISP-231) `[CONFIRMED-R1]`
| Contract type | department | class | location |
|---|---|---|---|
| DEFAULT | 15 | 104 | `'131'` |
| FONATEL | 137 | 9 | `'131'` |
| PHC | 135 | 10 | `'131'` (**not** 132) |

- `invoice.typeInt` = 12 → sent as `tipoFactura` = **12 as a JSON number** (not `"12"`). `[CONFIRMED-R1 config]`, payload FAILED in R1 (Bug_003).
- `locationInt` = 131.
- No duplicate rows per key in the mapping tables.

### Tax rule / exemption → NetSuite taxCode  (ISP-217, ISP-225, ISP-233, ISP-242, EFT-91/92/93)
| Situation | taxCode | Status |
|---|---|---|
| Levy lines `I_IMP_CR` (1%) and `I_IMP_911` (0.75%) | **5** | `[CONFIRMED-R1]` |
| 100% exemption **with** certificate | **6** | from round-1 expectation |
| Normal product line, IVA 13%, no exemption | **7** | `[CONFIRMED-R1]` |
| Partial exemption → effective IVA **8%** (38.46% exempt) | **8** | `[CONFIRMED-DB]` tax_exempt_taxcode_map |
| Partial → **4%** (69.23% exempt) | **9** | `[CONFIRMED-DB]` |
| Partial → **2%** (84.62% exempt) | **10** | `[CONFIRMED-DB]` |
| Partial → **1%** (92.31% exempt) | **11** | `[CONFIRMED-DB]` |
| 100% exemption **without** certificate | **12** | from round-1 expectation |
| Anything else / unmapped | **never 0**: Embrix must stop with its own error (MAP-005) | EFT-91/92 |

`[CONFIRMED-DB 10-12]` `core_config.tax_exempt_taxcode_map` (coopegsbx3) stores only the 2-dp form (`exemptrate` 38.46 / 69.23 / 84.62 / 92.31; `exemptpercent` = exempted points 5 / 9 / 11 / 12; code 5 = 13 pts with no rate (levies); 6 = 100% + certificate; 12 = 100% without; 7 = 0 pts). Accounts may store the 6-dp form (`84.615385`), so both must map the same way (MAP-008):
| Effective IVA | Exemption % (2 dp / 6 dp) | Tax on 10,000 |
|---|---|---|
| 1% | 92.31 / 92.307692 | 100.00 |
| 2% | 84.62 / 84.615385 | 200.00 |
| 4% | 69.23 / 69.230769 | 400.00 |
| 8% | 38.46 / 38.461538 | 800.00 |

`[AMBIGUOUS]` SIN_IMPUESTO line credit note (EFT-93): taxCode not specified anywhere. Record what is sent; do not judge.

---

## oracle-02 — Invoice / credit-note math

| ID | Scenario | Expected |
|---|---|---|
| MATH-01 | Manual invoice, `I_INT` × 1 @ 10,000, no exemption | I_INT 10,000 + IVA 13% 1,300; I_IMP_CR 1% = 100; I_IMP_911 0.75% = 75 → **total 11,475.00** `[CONFIRMED-R1 0279497]` |
| MATH-LEVY | Levy base | CR 1% and 911 0.75% are computed on the **Internet (I_INT) line only**; TV lines get none. Levy lines carry `taxCode 5` and `taxAmount = amount = grossAmount` `[CONFIRMED-DB A-1200192]` |
| MATH-02 | Line credit note WITH_TAX, 1,000 on the TV line | one `I_TV` item 1,000 + 130 = **1,130**, taxCode 7; `applys.amount` 1,130 |
| MATH-03 | Invoice-level credit note WITH_TAX 10% of MATH-01 | 10% of each line; `applys.amount` = SUM(items.grossAmount) = **1,147.50** `[ASSUMPTION]` levy lines are credited proportionally |
| MATH-04 | Intercompany auto credit note | WITH_TAX, 100% of the invoice; taxCode 7 on product lines (never 0) |
| MATH-08..11 | Partial exemption, 10,000 base | tax per oracle-01 table (100 / 200 / 400 / 800); taxCode 8..11 |
| MATH-12 | 100% exemption | taxAmount 0; taxCode 6 (certificate) or 12 (no certificate) |

Rounding: 2 decimals, the same in Embrix (Bills), the CREATE_INVOICE payload and NetSuite. `[ASSUMPTION]` half-up.

There is **no `I_IMP_IVA` item** in the payload; IVA travels as `taxAmount` on each product line `[CONFIRMED-R1]`.

---

## oracle-03 — Sync status fields on the invoice (Bills / invoice_unit)

| Outcome | financesyncstatus | financerefid | financeversion | financeerrormessage | Invoice |
|---|---|---|---|---|---|
| Success | `SUCCESS` | NetSuite response `data.id` | NetSuite `tranId` | empty / cleared | ACTIVE, unchanged |
| NetSuite business error | `ERROR` | empty | empty | NetSuite message **verbatim** | still ACTIVE (never rolled back) |
| Not yet sent | `PENDING` or NULL `[AMBIGUOUS]` (Bug_012: PENDING filter always empty) | empty | empty | empty | ACTIVE |

ENG-007 adds: a SUCCESS keeps its finance reference afterwards; an ERROR keeps the diagnostic message; a failure to write the activity log must not stop the status above from being saved.

Known NetSuite messages (store verbatim):
- `Elementos requeridos faltantes en la solicitud: entity` (missing customer)
- `No hay período fiscal abierto válido` (date outside open period)
- `No se ha encontrado un contrato con número…` (contract unknown to NetSuite; **expected, not a defect** for brand-new QA contracts)

---

## oracle-04 — CREATE_INVOICE header (NetSuite-bound JSON)

Read it from the Customer Activity of the invoice; prefer the **vendorRequestPayload** (exact NetSuite-bound JSON, handoff §5) over the canonical request.

| Field | Expected | Source |
|---|---|---|
| `entity` | account **partyId**, non-empty string (e.g. `"74003"` for 208886) | ISP-223 / ISP-292; handoff §2. FAILED R1 (Bug_002) |
| `tipoFactura` | `12`, number | handoff §2. FAILED R1 (Bug_003) |
| `department`, `class`, `location` | per oracle-01 | ISP-215 |
| `memo` | `Telecomunicaciones <MMM>-<YYYY>` in Spanish, from the **invoice date** (e.g. `Telecomunicaciones ABR-2026`) | ISP-245; A-1200192 |
| `mes` | Spanish month abbreviation, string (`"ABR"`) | A-1200192 |
| `annio` | year, number (`2026`) | A-1200192 |
| `subsidiary` / `currency` / `canal` | `"2"` / `"CRC"` / `"EMBRIX"` | A-1200192 |
| `idContrato` | contract (account) id, string | A-1200192 |
| `idProceso` | `<month without zero-pad><year>`: DIC-2026 → `'122026'`, ENE-2027 → `'12027'` | ISP-245 |
| `tranDate`, `fechaVencimiento` | invoice date / due date as `dd/MM/yyyy` strings (`"01/04/2026"`, `"16/04/2026"`) | A-1200192 |
| `coopewebId` | Embrix invoice id; used to find the record in NetSuite | round-1 |
| One CREATE_INVOICE activity per invoice | exactly one | ISP-239 |

Reference good payload: old build, contract 208886, invoice 278465 (April 2026), activity **A-1200192**: SUCCESS with entity `"74003"` and tipoFactura `12`; response `{"data":{"id":765105,"tranId":"FA508722"},"error":false,"status":200}`. Full copy: `evidenceeferenceA-1200192_CREATE_INVOICE_278465_old-build-SUCCESS.json` (read from coopegsbx3 snapshot 10-12). Header types: entity/location/subsidiary/idContrato/coopewebId/idProceso are **strings**; class/department/tipoFactura/annio are **numbers**.
Reference bad payload: new build, invoice 0279497, activity **A-1209153**: entity missing, tipoFactura `"12"`.

---

## Jira-confirmed rules (digest 10-12, `notes
etsuite-jira-digest.md`)
- Due date = tranDate + 15 days in every Jira example (NET_15) — ISP-202/215.
- `tipoFactura` history 11 → 6 → 12 (ISP-202 → ISP-215 → ISP-236); configurable via `invoice.typeInt` (ISP-231).
- Memo is null for non-ISP (Energy) invoices (ISP-202). Energy invoices ARE sent; nothing excludes prepaid.
- Credit-note line taxCode = parent invoice line taxCode (ISP-233/242); exemption is per item (TV 7, Internet 10/11 on the same account).
- Exemption 84.615385 must round to 84.62 → taxCode 10 (EFT-92 root cause).
- Credit-note memo = adjustment Notes (default ""); reasons that need no stamping still sync (EFT-86).
- Stamp-before-sync holds only since 2025-08-03 (ISP-239); older ISP-202/204 comments say the opposite.
- Unsynced parent invoice: undefined ("we assume … already synced", ISP-204) → CRN-007 records only.

## oracle-05 — CREATE_INVOICE items and CREATE_CREDIT_NOTES

Items: one per billable line; `taxCode` per oracle-01, `taxAmount` per oracle-02, `grossAmount` = amount + taxAmount.

Credit notes (ISP-204, ISP-238, ISP-239, ISP-242):
- Only **credits** are sent. **Debit notes are never sent** `[CONFIRMED-R1 CRN-005]`.
- `entity` = the account's partyId (**ENG-006 fix**).
- Reference good credit memo (snapshot, 2025-06-16): entity `"57936"`, department 15 / class 104, `memo` `""`, `motivoAnulacion` `"Compensatorias ND"`, I_INT 100 taxCode 11 tax 1.00, levy lines taxCode 5, `applys:[{"amount":101.14,"refNum":"231149"}]` → response `{"id":231453,"tranId":"NC159"}`. Request map GID-100081: `creditMemo.tranDate ← creditNote.notesDate`, `motivoAnulacion ← reasonDescription`, `memo ← notes`.
- `applys[0].refNum` = parent invoice's `financerefid`.
- `applys[0].amount` = SUM(items.grossAmount).
- Order: Hacienda stamping (CREATE_XML_…) **first**, then NetSuite sync (ISP-239). Confirmed for credit notes in 2025, inferred for invoices. R1 showed invoices logging CREATE_INVOICE first (Bug_010).
- Reason codes that do not stamp (e.g. `CUSTOMER_SATISFACTION`) still need a viewable PDF (EP-5342 / EFT-86).

---

## Environment facts used by the oracles
| Item | Value |
|---|---|
| Core UI under test | https://core-ui.coopegsbx2.embrix.org/ |
| GraphQL | https://service-transactional.coopegsbx2.embrix.org/graphql |
| CRM gateway | https://crm-gateway.coopegsbx2.embrix.org |
| NetSuite sandbox | account `8754760-sb1` (https://8754760-sb1.app.netsuite.com); login on EFT-88 (Adrian, 10-07); MFA (Adrian helped on 10-09) |
| Open NetSuite periods | **Jan 2025 → Dec 2027**, staying open all year (client via Adrian, 10-09). Never use 2028 dates |
| CCP clock | invoice date always follows the tenant clock; `txnDate` on manual invoices is ignored (R1 INV-010). Round-1 clock: 2027-09-01 |
| Finance sync config (handoff §4, inspected DB) | `realTimeFinanceSync=false`, `financeSyncBatchMode=API`, `financeSyncBatchSize=5`; no FINANCE_SYNC_INVOICE schedule found |
| Execution path (handoff §4) | service-proxy → jobs-common → Engine finance sync → Finance Gateway (`POST /invoice/create`) → NetSuite |
| Mapping | DB-driven: `core_config.gateway_api_map` FINANCE_GATEWAY / NETSUITE / CREATE_INVOICE = GID-100077; `core_config.gateway_api_requestmap`: `invoice.entity ← account.partyId`, `invoice.tipoFactura ← invoice.typeInt` |
