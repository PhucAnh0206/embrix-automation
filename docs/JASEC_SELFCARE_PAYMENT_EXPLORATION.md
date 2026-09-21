# JASEC — Self Care payment flow: exploration findings

Exploratory pass over Self Care **Activity → Make Payment** and **Billing Data → Payments**.
Environment: `jasec-dev`. Date: 2026-08-26. Owner: Anh Tran (QC).

Nothing here is a ticketed test case. No TC numbers — numbering comes from the
EPDP-348 sub-task list once a proposal is accepted. Specs are named `explore-*`
and live in `tests/regression/jasec/payment/`, project `jasec-payment`.

---

## 1. Where the payable records come from

This was the open question. The chain, read backwards from real records:

```
charges accumulate on the account
  → core_engine.transaction_unit
  → end-of-cycle billing job
  → core_engine.bill_unit                one per cycle
  → core_engine.invoice_unit             status ACTIVE, due > 0
  → GraphQL searchInvoiceUnits
  → Self Care "Select Invoices" grid on Activity → Make Payment
```

**The bill is produced by the end-of-cycle billing run. What is IN it varies**, and
this matters more than it first looks — an earlier version of this document said
"rated MDR usage" as if that were the only source. Two compositions seen on jasec-dev:

| Composition | Transactions on the bill unit | Example |
|---|---|---|
| **Monthly fixed charges** | 4 rows, `source = BILLING` (items I-100003…I-100006), zero MEDIATION | LCHONG000001 bill 000173: 2077.20 + 144.30 + 91.50 + 6.30 = **2,319.30** = the invoice total exactly |
| **Rated meter consumption** | many rows, `type = USAGE, source = MEDIATION` | ACT-100145 bill 621: 252 USAGE/MEDIATION + 64 TAX rows → 4,802,880.12 |

Worth knowing which you are looking at: **every bill this suite has actually paid was
the fixed-charge kind** — they are the small ones, and the target filter picks
cheapest-first. The one MDR-derived payable bill on a CRC account with a saved card is
ACT-100145's 000160 at 5,354,343.60, far above the safety cap. So the payment half has
never been exercised against a consumption-derived bill. See "What is NOT covered yet".

Paying one writes:

| Object | Change |
|---|---|
| `core_engine.payment` | new row `P<n>` — status `CLOSED`, `remainingamount` 0, `method` `CREDIT_CARD`, `invoiceunitid` = the invoice, `externaltransid` = the PlaceToPay transaction |
| `core_engine.invoice_unit` | status `ACTIVE` → `CLOSED`, `due` → 0, `lastaraction` → `PAYMENT` |
| `core_engine.arops_unit` | new row type `PAYMENT`, `netamount` **negative**, `source` `AGENT_CARE`, `invoiceid` = the invoice |
| `balance_unit_balances.amount` | moves **down** by exactly the amount paid |

So **Make Payment is invoice settlement**, not a wallet screen. Top Up — one item
away in the same Activity dropdown — credits the wallet, creates no invoice and no
`payment` row. The two screens look alike and are easy to confuse.

Confirmed on `ACT-100145` (the account in the original report): its `P137` /
4,802,880.12 CRC came from invoice `000351`, which came from bill unit `621`,
which came from 252 `USAGE` / `MEDIATION` transactions plus 64 `TAX` rows.
Nobody had entered a payment by hand.

That was a backward trace. **It has since been proven forward as well** — see
"Forward proof" below: a brand-new account was made to consume 25 kWh, the billing job
was run, and a payable bill appeared containing exactly that consumption.

### The balance question, answered

JASEC CRC is inverted: **negative = credit the customer can consume, positive =
debt.** A payment therefore *subtracts* from `balance_unit_balances.amount`.
Measured on every paying run, exact to the cent:

| Case | Account | Invoice | Paid | Balance before → after | Delta |
|---|---|---|---|---|---|
| Pay Now | ACT-100489 (USD) | 000099 | 4.46 | −10.32 → −14.78 | −4.46 ✓ |
| PlaceToPay | ACT-100529 (CRC) | 000137 | 2,319.30 | −361.40 → −2,680.70 | −2,319.30 ✓ |
| PlaceToPay | LCHONG000001 (CRC) | 000173 | 2,319.30 | −2,100.70 → −4,420.00 | −2,319.30 ✓ |
| Pay Now | JASEC000002 (CRC) | 000180 | 2,319.30 | −1,281.40 → −3,600.70 | −2,319.30 ✓ |

The balance moves by the paid amount, to the cent, on both channels. In
customer-facing wording that is "credit went up" — the same event from the other
side. Assertions are written against the signed DB value only, never against a
word like "increase".

---

## 1b. Forward proof — driven from nothing, on 2026-08-26

`explore-03-prove-bill-from-root.spec.ts`, account `ACT-100651` on jasec-dev. Every
step measured, nothing pre-existing:

| Step | What happened |
|---|---|
| Create account + order + meter | `ACT-100651`, order `ORD-1126`, meter `00210031964177568`. Baseline: **0 invoices, 0 payments, balance 0**, `service_provision` type=METER present |
| Top up 20,000 CRC | balance → **−20,000.00** (negative = credit) |
| Submit one meter reading | 25 kWh, through the real loader on the jumphost. Loader confirmed "will rate: 25.00000 kWh" |
| Rating | 4 `USAGE`/`MEDIATION` rows: 1567.25 − 14.50 + 66.75 + 0 = **1,619.50 CRC**. Balance → **−18,380.50**, i.e. exactly −20,000 + 1,619.50 |
| Still no bill | consumption alone produces nothing payable — confirmed 0 invoices |
| Move CCP to 2026-10-09, run BILL_CHECK → BILL_CC → INVOICE_CHECK | schedule `JS-100241` |
| **Bill appears** | invoice `001785`, ACTIVE, total **2,006.05**, due 2,006.05 |
| What is in it | 4 rated-consumption rows (**1,619.50**) + 4 fixed-charge rows (346.20 + 24.05 + 15.25 + 1.05 = **386.55**) = **2,006.05** — the invoice total to the cent |
| Self Care | lists `001785` and offers it for payment |
| Pay it | gateway approved **₡2.006,05 CRC** |
| Recorded? | **NO** — D2 again, this time on a CRC account |

So the chain is proven end to end **up to the payment**, and the arithmetic closes
exactly: the 25 kWh rated in the first half is the same 1,619.50 CRC sitting inside the
bill the billing job produced in the second half. That is the link the backward trace
could only infer.

The final step failed for a product reason, not a test one, and it is what broadened
D2 from "non-CRC accounts" to something wider. Two findings came out of building this
that no amount of reading existing data would have surfaced: **D5** (the declared
initial meter reading is ignored) and the correction to **D2**.

Three things had to be learned the hard way to get here, all now encoded in the spec:
- The **declared initial meter reading does not seed the rating baseline** (D5). The
  first attempt submitted `12,300 + 25` and rated 12,325 kWh.
- A date holds **at most two `job_schedule` slots**, one per frequency. The account's
  required date already had `DAILY:COMPLETED` and `SCHEDULED:ERROR`; only a
  non-COMPLETED slot can be reclaimed.
- `scheduleName` is a **foreign key** into `core_config.config_job`, which holds exactly
  one row on this tenant (`DAILY`). A descriptive name fails the FK.

## 2. Findings

### D1 — Make Payment shows no invoices until the page is reloaded — **blocks paying**
`[DEFECT]` Reproduced 7/7 runs across four accounts.

Arriving via Activity → Make Payment fires only `getAccountById` and
`getTenantSelfCareConfig`. **`searchInvoiceUnits` never runs**, so the grid shows
"No record has found!" even when the account has open invoices. A browser reload
of the same URL fires it and the rows appear.

| Account | Rows on arrival | Rows after reload | Open invoices in DB |
|---|---|---|---|
| ACT-100145 | 0 | 1 | 1 |
| ACT-100489 | 0 | 2 | 2 |
| JASEC000002 | 0 | 2 | 2 |
| LCHONG000001 | 0 | 1 | 1 |

Impact: a customer who lands on Make Payment and does not think to press F5 sees
an empty screen and cannot pay their bill. This is the most user-visible item in
this pass. Pinned by **Scenario 1 step 2** (soft), which is why the journey's reload
is written into step 3 in plain sight.

### D2 — `applyExternalPayment` refuses the payment, and Self Care shows nothing
`[DEFECT]` The error is captured and reproducible. **The trigger is NOT identified** —
six candidate explanations have each been tested and each has a counterexample. This
needs a server-side trace; black-box plus DB inspection has gone as far as it can.

**What is solid.**

The mutation and its answer, captured verbatim:

```
mutation { applyExternalPayment(input: {accountId: "ACT-100651", userId: "congeroadmin",
    paymentDate: "2026-08-26", source: AGENT_CARE, amount: 2006.05,
    allocationData: [{invoiceUnitId: "001785", amount: 2006.05, accountId: "ACT-100651"}],
    vendorName: "PLACETOPAY", vendorTransactionId: "1599878861",
    vendorAuthorizationCode: "514250", vendorReceipt: "926342881380",
    vendorLast4: "0081"}) { id } }

HTTP 200
{"data": {"applyExternalPayment": null},
 "errors": [{"errorType": "DataFetchingException",
             "message": "Error encounter while applying payment. No revenue journal
                         data found for the given account and item"}]}
```

- The gateway **approves and charges** first (`vendorAuthorizationCode` present), then
  Embrix refuses to record it.
- No `core_engine.payment` row, bill stays ACTIVE at full due, balance unmoved — while
  the customer is shown a receipt number and an authorization code.
- It does not reach `core_engine.payment_suspense` either — the table that exists for
  payments that cannot be applied (18 rows on this tenant, none for any affected
  account).
- Self Care shows the backend error in a toast AND a green "Payment approved" panel
  with a receipt number, at the same time. The toast auto-dismisses; the success panel
  persists. See D2b — that half is unambiguous and independently actionable.
- Currently reproducible on at least three live bills: `ACT-100651`/`001785`,
  `ACT-100042`/`000037`, `ACT-100529`/`000350`.

**What has been ruled out.** Each by a run that changed one variable:

| Candidate | Ruled out by |
|---|---|
| Account currency | `ACT-100651` is CRC and fails |
| Card on file / payment-profile method | Saved a card on `ACT-100651` (`CHECK`/0 → `CREDIT_CARD`/1), same bill, same channel — still refused |
| Payment channel | Pay Now refuses the same bill; Pay Now settles other bills fine |
| A zero-amount bill line | `ACT-100042`/`000037` has **no** zero line (4 non-zero lines) and still fails |
| Revenue-journal rows on the account | `ACT-100529`/`000137` **paid successfully with zero journal rows**; `000350` on the same account, also zero journal rows, is refused |
| Invoice date / billing cycle | `JASEC000002`/`000277` dated 2026-10-09 **paid**; `ACT-100529`/`000350` dated 2026-10-09 is refused |
| CCP clock position | Moving the clock back to its original 2026-08-05 did not restore payment on `ACT-100529` |

**The one clean observation left.** `ACT-100529` paid bill `000137` successfully at 05:35,
and now refuses bill `000350` — same account, same card, same channel, same clock, both
bills with zero journal rows. So the trigger is a property of the individual bill (or of
something time-dependent that is not the CCP clock), and it is not visible from the
tables inspected so far.

**Honest note on process.** Three successive root causes were written into this document
and each was wrong: the account currency, then a zero-amount line, then invoice date. The
zero-line story fitted `ACT-100651` perfectly — exactly one transaction on that bill had
no journal row and it was the 0.00 one — which is a good reminder that a mechanism fitting
one case is not the same as a mechanism being the cause. Each was disproved by a run, and
the runs are what the team should trust here, not the narrative.

**Environment note.** The forward proof moved the tenant CCP clock from 2026-08-05 to
2026-10-09 and it has been **restored to 2026-08-05**. That move did not cause D2 (the
first failures predate it, and restoring it did not fix them), but anyone reading DB state
from this window should know it happened.

**What the team needs to do.** Trace `applyExternalPayment` server-side for one refused
bill and find what "revenue journal data for the given account and item" it is looking
for and why the lookup fails. Reproduce in one command:

```powershell
$env:PAYMENT_ACCOUNT_ID="ACT-100529"
npx playwright test --project=jasec-payment-diagnose
```

That is `diagnose-01-payment-drop.spec.ts` — a throwaway probe that records the full
request and response of the payment click. `DIAG_CHANNEL=ptp` switches it to PlaceToPay
for accounts with no stored card. Delete the file once this is understood.

### D2b — Self Care shows "Payment approved" with a receipt number for a payment that was refused
`[DEFECT]` **Confirmed manually through the UI, 2026-08-26.** Corrects an earlier claim in
this document that the error was hidden — it is not.

What the customer actually sees after clicking PAY NOW on a bill that the backend
refuses — both at the same time:

- A green panel in the page body: **"Payment approved — Receipt: 011125494478 |
  Authorization: 321004 | Amount: 2006.05 CRC"**
- A red toast, top right: **"Error encounter while applying payment. No revenue journal
  data found for the given account and item"**

And the bill stays listed at 2,006.05, unpaid.

The two messages contradict each other, and the **wrong one is the one that persists**:
the toast auto-dismisses after a few seconds, the green "Payment approved" panel stays.
A customer is left looking at a success message with a receipt number and an
authorization code for a payment that was refused and a bill that is still outstanding.
They have every reason to believe they have paid.

The receipt and authorization numbers are real — they come from the gateway, which did
approve and charge the card. Embrix then refused to record it. So the money moved and the
customer holds a receipt for it.

**Why the automation reported this as "no error shown" — a method error worth recording.**
Playwright's failure screenshots are taken when the test fails, which was minutes after
the click. By then the error toast had auto-dismissed and only the green panel remained.
Nothing ever asserted the absence of a toast; it was inferred from a screenshot taken too
late. Lesson: to claim a transient UI message is absent, capture at click time or listen
for it explicitly — never conclude it from a late screenshot.

**Fix, independent of D2's unknown trigger:** do not show "Payment approved" when
`applyExternalPayment` returns an error. Whatever is causing the refusal, the success
panel is wrong and it is the message the customer is left with.

### D3 — The payment Id pill opens nothing (the reported break, now with evidence)
`[DEFECT]` Already raised with the team; this pass characterises it.

Clicking the `Id` pill (e.g. `P137`) in Self Care → Billing Data → Payments
produces: no popup, no download, **no document request at all**, no new tab, and
**not even a console error**. A completely silent no-op.

Root cause is upstream of the click: **`core_engine.payment.filepath` is NULL on
every payment row on this tenant**, as are `folioid` and `foliostatus`. There is no
document for the click to fetch, so the fix is likely "no receipt is ever
generated", not "the click handler is broken". Worth telling the team, since it
changes who owns it.

Confirmed on a **brand-new** payment as well as the reported one: `P141`, created by
this pass's own E4 run, behaves identically. So it is not stale data on an old row —
no payment gets a document. Pinned by **Scenario 1 step 9** (soft).

### D4 — Self Care's payment row renders fields the DB has
`[DEFECT]`

For `P137`, the grid renders:

```
ACT-100145 | 2026-08-26 | P137 | (blank) | (blank) | CLOSED | 4802880.12 | (blank) | (blank) | 0
```

against columns `Account Id | Payment Date | Id | Transaction Id | External Id |
Status | Amount | Currency | Payment Method | Remaining Amount`. Three of those
blanks are populated in `core_engine.payment`:

| Column | Rendered | DB |
|---|---|---|
| Payment Method | *(blank)* | `CREDIT_CARD` |
| External Id | *(blank)* | `1599878724` |
| Currency | *(blank)* | `CRC` (`sourcecurrencyid`) |
| Transaction Id | *(blank)* | `NULL` — consistent, nothing to show |

Also reproduced on the freshly created `P141` (`CREDIT_CARD` / `1599878763` / `CRC`
in the DB, all three blank on screen), so it is not specific to the reported row.

A customer cannot tell how they paid or match the charge to their card statement.
Pinned by **Scenario 1 step 8** (soft). Note `transactionid` being NULL while
`externaltransid` carries
the gateway reference looks like a separate data-model question worth asking.

### D5 — A new meter's declared initial reading is ignored, and the first reading is rated in full
`[DEFECT]` / `[RISK]` — found while building the forward proof. High potential impact.

The order flow takes a **lectura inicial** (initial meter reading) and stores it on
`core_engine.service_provision.flexattr1`. **Rating does not use it.** It takes the
delta against `core_mediation.energy_cdr_detail`, which is EMPTY for a newly
provisioned meter — so previous = 0 and the FIRST reading is rated in full.

Measured on `ACT-100650` (2026-08-26): order declared 12,300 kWh, first MDR reading
submitted at 12,325 kWh. Expected 25 kWh of consumption; **12,325 kWh was rated**. The
account went from 20,000 CRC in credit to **1,070,793 CRC in debt** off one reading.

In production that is a customer billed for the meter's entire lifetime odometer on
their first invoice. Either the order's declared reading has to seed the mediation
baseline, or the first reading after installation must be treated as a baseline and
rated at zero. Worth asking JASEC and Embrix which is intended.

Note the account stayed `ACTIVE` despite the debt — suspension is driven by
`CREDIT_LIMIT_ACTIONS`, which had not run.

Workaround used by the proof: read mediation's own position for the meter and add the
intended consumption to that, rather than trusting the declared initial reading.

### D6 — Prepaid invoices are payable at all, and paying re-credits the wallet
`[RISK]` / `[AMBIGUOUS]` — design question for JASEC, not asserted.

`JASEC-knowledge.md` line 34: a prepaid customer **pays in advance** through
top-ups, and the month-end invoice + statement exists for **Hacienda fiscal
reporting**. The money has already been collected.

Yet the invoice carries a `due`, Self Care offers it for payment, and paying it
**credits the wallet again** (AR `netamount` negative). On `ACT-100145` that has
produced a −4,804,580.12 CRC balance: 4.8M CRC of consumable credit created by
paying an invoice for energy that the wallet had already been debited for.

Two further observations from the same data:
- **Paying does not lift suspension.** `ACT-100145` sits `SUSPENDED` with 4.8M CRC
  of credit. A top-up triggers reconnection; an invoice payment appears not to.
- **Self Care payments are recorded as `source = AGENT_CARE`, `userid =
  congeroadmin`.** Made while an admin was acting as the account — which is how
  Self Care is reached in these tests — there is then no audit distinction between
  a customer paying for themselves and an agent paying on their behalf. Worth
  confirming what a real customer login records.

Whether prepaid invoices should be payable at all is JASEC's call. **Scenario 1
step 10** records the evidence and asserts nothing, rather than pinning a behaviour
nobody has agreed.

### D7 — Historic duplicate payments in the POC data
`[RISK]` Not reproduced in this pass; flagged from existing rows.

`AC-Jasec-01` has three payments — `P69`, `P71`, `P73` — of 100,000 each, all
against invoice `INV-JASEC-POC-010`, **all sharing one `externaltransid`
`1599795189`**. `P79`/`P81` are the same shape (500 each, `externaltransid`
`1599795201`, invoice `INV-JASEC-POC-001`).

One gateway transaction became two or three payment rows. That is the signature of
a missing idempotency guard on the payment-return handler, and it rhymes with the
known top-up idempotency defect. Scenario 1 step 6 checks for **exactly one** new payment row on both
channels, so a recurrence gets caught. A dedicated
rapid-double-click / double-return case is the obvious next case to add.

---

## 3. Automation delivered

```
tests/regression/jasec/payment/
  explore-01-make-payment-recon.spec.ts   R1  Make Payment: screen dump + API trace + selection probe
                                          R2  Core UI Billing Data → Payments + Id link probe
                                          R3  Self Care Billing Data → Payments + Id pill probe

  explore-02-payment-journey.spec.ts  Scenario 1  the whole journey, 10 named steps,
                                                  run TWICE (@ptp / @paynow)          RED (soft: D1, D3, D4)
                                      Edge 1      declined card changes nothing        PASS
                                      Edge 2      approved charge on non-CRC account   RED (D2)

  explore-03-prove-bill-from-root.spec.ts  Phase A  new account → credit → 25 kWh → rated   PASS
                                           Phase B  billing run → payable bill → pay it   RED (D2 at the last step)
      Its own project `jasec-payment-proof`, gated behind PAYMENT_PROOF_RUN: it moves the
      tenant CCP clock and spends a job_schedule slot. Needs ssh to the loader host.

pages/selfcare/selfcare-make-payment.page.ts   the Select Invoices grid, selection, both pay buttons
pages/selfcare/selfcare-payments.page.ts       the customer-facing payments grid + Id-pill probe
helpers/payment-db.helper.ts                   target selection + before/after snapshots + diffs
```

### Why one scenario and not ten cases

The first pass split this coverage into ten separate tests. That was wrong twice
over: it paid the login + account-setup cost ten times for one journey, and — because
a failed assertion aborts a test — it reported **one defect per run**.

Scenario 1 is the journey as a customer walks it, with `test.step()` for the ten
steps so the HTML report reads like the S001-style step list. The three defects that
sit ON the happy path are `expect.soft` checks: the journey records them and keeps
going, so **one run surfaces all three**. The test still ends RED, and a final log
line says whether the journey itself completed:

```
JOURNEY COMPLETED — paid 000173 successfully, with 5 known defect(s) on the way:
  step 2: grid empty on arrival (0 rows vs 1 in DB) |
  step 8: Payment Method blank (DB has "CREDIT_CARD") |
  step 8: External Id blank (DB has "1599878792") |
  step 8: Currency blank (DB has "CRC") |
  step 9: Id pill opened nothing (filepath NULL)
```

That line matters: without it, "the customer could not pay at all" and "a display
field was blank" both just read as a red test.

Scenario 1's ten steps: 1 bill exists → 2 listed on arrival *(soft, D1)* → 3 listed
after reload and matching the record → 4 select → 5 pay → 6 bill settled, one payment
+ one AR row → 7 balance moved by exactly the amount → 8 payment visible with its
details *(soft, D4)* → 9 Id pill opens the document *(soft, D3)* → 10 record the
prepaid side effects (D5).

**Only two things stayed separate**, because neither can be a step on that path:
Edge 1 needs a card that *declines* (Scenario 1 only ever uses one that approves), and
Edge 2 needs an account in a *different currency* (on the CRC account the journey
uses, that path works correctly).

Step 2 deserves a note: until D1 is fixed the journey **must** reload to continue, so
the reload is written into step 3 explicitly rather than hidden in the page object.
Nobody should be able to read a green journey as proof that a customer can pay
without pressing F5. When D1 is fixed, step 2 goes green and the reload comes out.

Also changed:
- `pages/selfcare/selfcare-activity.page.ts` — added `navigateToMakePayment()`.
- `pages/selfcare/placetopay-checkout.page.ts` — added `completePaymentAndReadOutcome()`
  (captures the gateway verdict and the charged amount+currency) and
  `screenshotForEvidence()`.
- `fixtures/jasec-fixtures.ts` — wired the two new page objects.
- `playwright.config.ts` — new `jasec-payment` project.
- `helpers/db.helper.ts` — the pool now survives an idle drop (see §5).
- `.gitignore` — `artifacts/` (see §5).

### Running it

Tags are kept non-prefixing (`@edge-1`, `@edge-2`, `@ptp`, `@paynow`). Playwright's
`--grep` is a substring match: in the first pass, single-digit tags meant
`--grep "@e1"` also selected `@e10`, which fired a real gateway charge from a run
meant to be read-only.

```powershell
# recon only — read-only, safe any time
npx playwright test --project=jasec-payment --grep "@recon-1"

# the full journey, both channels — SETTLES TWO REAL INVOICES
npx playwright test --project=jasec-payment --grep "@scenario-1 "

# one channel at a time — SETTLES ONE REAL INVOICE
npx playwright test --project=jasec-payment --grep "@ptp"
npx playwright test --project=jasec-payment --grep "@paynow"

# edge cases. Edge 1 consumes nothing; Edge 2 leaves its bill open (that IS the defect)
npx playwright test --project=jasec-payment --grep "@edge-1|@edge-2"

# pin one account (debugging)
$env:PAYMENT_ACCOUNT_ID="ACT-100529"; npx playwright test --project=jasec-payment --grep "@ptp"

# the forward proof. Separate project, MOVES THE TENANT CLOCK, spends a job slot,
# needs ssh to the loader host. Run the two phases separately.
npx playwright test --project=jasec-payment-proof --grep "@proof-a"
npx playwright test --project=jasec-payment-proof --grep "@proof-b"

# resume Phase A on an account it already built (skips creation and the top-up)
$env:PROVE_ACCOUNT_ID="ACT-100651"; $env:PROVE_METER_ID="00210031964177568"
npx playwright test --project=jasec-payment-proof --grep "@proof-a"
```

Note the trailing space in `--grep "@scenario-1 "` — harmless today, but keep the
habit: it is the same substring-match trap as above.

Cost: the journey is ~1.5–2 min per channel and consumes one open invoice each. A
full run of all four tests is ~7 min and consumes two invoices.

Env knobs: `PAYMENT_ACCOUNT_ID` pins a target; `PAYMENT_MAX_DUE` (default 20000)
caps how large an invoice a paying case may charge — heavy MDR accounts carry
multi-million-CRC invoices and a stray run must not fire one.

Cost: read-only cases ~1 min each; paying cases ~1.5–2.5 min each. Long background
runs get killed on this machine at ~4–13 min, so run paying cases in the foreground
in small groups.

### Test data and portability — find, and report BLOCKED

**Decision: this suite FINDS its test data and does not create it.** When it cannot
find a usable account it reports **BLOCKED** — a skip carrying the reason, printed to
the run output — rather than failing. That is deliberate, not an oversight.

Why not seed: a PASS/FAIL is a statement about the product. "There is no test data on
this environment" and "the VPN is down" are statements about the environment, and
dressing either up as a failure sends whoever reads the report hunting a defect that
does not exist. Manual QC has always called that BLOCKED; the automation says the same
word.

Three things produce a BLOCKED skip, each with its own message:

| Situation | Message says |
|---|---|
| Database unreachable | check the AWS VPN, then re-run |
| No payable account on the environment | the three things to create, and points here |
| Pool used up by earlier tests in the run | run the rest separately, or widen `PAYMENT_MAX_DUE` |

Reported as a **skip**, never a failure. `test.skip`'s reason is only an annotation and
the list reporter does not print it, so `blockUnless()` also `console.log`s the reason
— without that, a blocked run was three bare "skipped" lines with no explanation.

**What creating a payable prepaid bill actually costs.** A genuine cycle bill is the
end of the whole upstream pipeline:

```
create prepaid account + order + meter   (fixtures/create-prepaid-account.helper.ts:
                                          ~2.9s via CRM gateway, ~95s via Core UI)
  → save a card                          (Self Care → Activity → Manage Payment Profile,
                                          PlaceToPay tokenization round trip)
  → feed meter readings                  (the remote MDR loader, over SSH)
  → rating produces usage charges
  → move the CCP clock to next month day 1
  → run the end-of-cycle billing job
  → bill_unit → invoice_unit (ACTIVE, due > 0)
```

That is why the seeding does not belong *inside* the payment tests:

- The **CCP clock is tenant-global.** A payment test that moves it changes the
  environment under everyone else's feet.
- The **billing job spends one of only 2 `job_schedule` slots per calendar date.**
- It needs the **remote MDR loader over SSH**, which the payment tests otherwise do
  not touch at all.
- **Failure attribution breaks.** If mediation or billing hiccups, the payment test
  goes red — and you end up debugging billing while trying to test a screen.

**A much cheaper path exists, and the recon proved it viable.** The screen's own query
is:

```graphql
searchInvoiceUnits(page: 1, size: 200, sort: dueDate_DESC,
                   filter: {accountId: "…", status: ACTIVE})
```

It filters on **account and status only** — no invoice-type filter, and (worth noting
separately) no `due > 0` filter. So a **manual invoice** (Billing Center → Billing →
+ MANUAL INVOICE) would appear in Make Payment and be payable, with no clock move, no
MDR readings and no job slot. Unverified so far: no `type = MANUAL` invoice exists on
jasec-dev, a manual invoice needs an Item ID that already exists in the JASEC price
catalogue, and there is no page object for that screen yet.

**If seeding is ever wanted**, the shape would be a `payment-seed` step run **once per
environment** — not once per test — topping the pool up to N accounts, with the tests'
`find` logic left exactly as it is. The manual-invoice route above is the cheap
mechanism to try first. That is a deliberate "not now": the BLOCKED message already
tells whoever hits it what to create, and on jasec-dev there are 40+ usable accounts,
so the cost of seeding buys very little today. Revisit it when this suite needs to run
on a clean environment — preprod, staging, or a rebuild.

Side note from the same query: because there is no `due > 0` filter, an ACTIVE invoice
with **zero or negative** due is listed and offered for payment. Only one negative-due
invoice exists on the tenant today and no pool account has one, but steps 2 and 3
deliberately compare against "ACTIVE, any due" — the screen's own definition — so
such an account cannot produce a baffling false failure. Whether the screen *should*
offer a zero-due bill for payment is an untested question and a candidate case.

### Test-data pool

40+ `ACTIVE` CRC prepaid accounts on `jasec-dev` have both a saved card and 2 open
invoices of 2,319.30 CRC — plenty for repeated paying runs. Selection is
cheapest-first, CRC-only, capped, and each run claims accounts it has not used.
When the pool runs dry the fix is a billing cycle, not a bigger cap.

This pool is why the suite works today on jasec-dev and would not work on a clean
environment — see "Test data and portability" above.

---

## 4. What is NOT covered yet

- **Seeding its own test data.** The suite finds a payable account rather than
  creating one, so on a clean environment it reports BLOCKED instead of running. An
  accepted trade-off, not a bug — see "Test data and portability" for the cost of the
  alternatives and when to revisit.
- **Multi-invoice payment.** The grid is multi-select with a running total; every
  case here pays exactly one invoice. Partial allocation across several invoices,
  and whether the total charged matches the sum, are untested.
- **Paying a zero-due or negative-due bill.** The screen lists any ACTIVE invoice
  regardless of amount outstanding, because its query has no `due > 0` filter.
- **Paying a bill derived from rated meter consumption.** Every bill paid so far was
  the monthly-fixed-charge kind. Cheap MDR-derived payable bills DO exist on CRC
  accounts (e.g. ACT-100042 / 001566 at 479.04, several at 2,006.05) — but none of
  them has a saved card, so the target filter never picks one. The filter requires a
  card because PAY NOW needs a stored token; **PAY WITH PLACETOPAY does not**, so
  dropping that requirement for the PlaceToPay channel would both widen the pool and
  let the journey run against a consumption-derived bill. Small change, real coverage
  gain.
- ~~Producing a payable bill from scratch~~ — **done**, see "Forward proof".
- **What triggers D2.** The error is captured and six candidate causes are ruled out by
  experiment. Needs a server-side trace — not another black-box hypothesis.
- **Payment idempotency** (D6) — double-click, double-return from the gateway,
  browser-back after approval.
- **Abandoning the PlaceToPay session** from Make Payment (the top-up suite covers
  the equivalent for tokenization).
- **A real customer login**, rather than an admin acting-as. That is what would
  settle the `AGENT_CARE` attribution question in D5.
- **Spanish UI.** Every locator has an ES alternative but no case runs in Spanish.
- **Postpaid.** Everything here is prepaid; the postpaid invoice-payment path is
  untouched.
- **Core UI ↔ Self Care consistency** as an assertion. R2 dumps the Core UI grid
  but nothing compares the two views of the same payment yet.

---

## 5. Three traps worth remembering

**Playwright clears `test-results/`.** A recon JSON written there vanished between
the run finishing and being read, taking `test-results/logs/` with it. Evidence now
goes to `artifacts/` (gitignored) *and* is attached to the test, so it survives in
the HTML report either way. The team's `notification-report.helper.ts` and
`test-logger.ts` still write under `test-results/` and are exposed to the same loss.

**`--grep` is a substring match, and it can spend money.** With single-digit tags,
`--grep "@e1"` selected `@e1` *and* `@e10` — and `@e10` fires a real gateway charge.
That happened once here from a run meant to be read-only. The restructure removed the
numbered tags entirely (`@scenario-1`, `@edge-1`, `@edge-2`, `@ptp`, `@paynow` — none a
prefix of another), but the rule stands for any tag added later. Worth checking in the
other suites: `@tc-1-1` style tags in the top-up specs have the same shape.

**The DB pool dies during long UI waits.** `idleTimeoutMillis` is 30s, and these
specs leave the pool idle for minutes between snapshots. An idle client the server
had already closed surfaced as `Connection terminated unexpectedly` on the *next*
test in the file. `DbHelper.query` now retries once after rebuilding the pool, and
the pool has an `error` handler so a dropped idle client cannot take the worker
down. This affects every DB-backed JASEC spec, not just these.

Related: `TestLogger.flush` threw `ENOENT` when its own directory under
`test-results/` had been cleared mid-run, adding a second misleading error to an
already-failing test. It now re-creates the directory and never throws.

---

## 6. Suggested next steps

1. Raise **D1** first — it stops customers paying and is a small front-end fix.
2. Send **D3** back with the `filepath` finding attached: the click is probably not
   the bug, the missing receipt is.
3. Ask JASEC the **D5** question — should a prepaid invoice be payable at all, and
   should paying one reconnect a suspended service?
4. Ask the team about **D2** — is the PlaceToPay return handler currency-scoped?
   Even if JASEC stays CRC-only, the silent drop is worth a look.
5. Add the multi-invoice and idempotency cases once D1 is fixed (both are much
   easier to write against a grid that populates on arrival).
