# ns-cycle.ps1 -- NetSuite cases that need a provisioned contract on coopegsbx2 (REG-001/002, INV-002, SUS-001, CHG-001,
# CAN-001/002, MAP-003, MAP-007, ENG-007-02). Every step sets the CCP clock and puts it back to NS_BASELINE (default 2027-01-01).
#
#   .\ns-cycle.ps1 full -Start 2027-01-01 -CleanSchedules    whole cycle on a new contract (about 45 min), see "full" below
#   .\ns-cycle.ps1 suspended -Start 2027-01-01 -CleanSchedules   exploration of the suspended-line billing rules of the 26 Oct
#                                                             release (ISP-286/287, UAT guide UAT-06..10), see "suspended" below
#   .\ns-cycle.ps1 provision -Tag N -Date 2027-01-01         new contract, provisioned: N normal, X no Party Id, H PHC, I intercompany,
#                                                             T Internet + TV, B business (ENTERPRISE)
#   .\ns-cycle.ps1 discount -Account <id> -Date 2027-09-12 -Offer Recurring_Discount_Internet   Modify order adding a discount + finish
#   .\ns-cycle.ps1 schedule -Date 2027-02-01                 Daily Schedule of a date (new, or the PENDING one Embrix created)
#   .\ns-cycle.ps1 order -Account <id> -Kind Suspend -Date 2027-01-10 -Expect SUSPENDED   Place Order (Cancel/Suspend/Resume) + finish
#   .\ns-cycle.ps1 finish -Account <id> -Date 2027-02-21 -Expect SUSPENDED                finish the open order (collection SUSPEND,
#                                                             RESUME after payment, MODIFY): DB step + Submit order at its date
#
# Needs: VPN on (DB step), Core UI login in .env.coopegsbx2, the ONT free (one contract at a time: cancel the previous one first).
# Never Kiet's ONT ALCLB3A97FBA.
# Tools used: <Embrix>\test-cases\netsuite\tools (clock, complete-order, order-check, pay-invoice, plan-change,
# clean-schedules, contract-state). Runbook: docs\NetSuite\NEXT-RUN.md.
param(
  [Parameter(Mandatory, Position = 0)] [ValidateSet('full', 'suspended', 'provision', 'discount', 'schedule', 'order', 'finish')] [string] $Step,
  [string] $Date, [string] $Start, [string] $Account, [string] $Offer = 'Recurring_Discount_Internet',
  [ValidateSet('N', 'X', 'H', 'I', 'T', 'B')] [string] $Tag = 'N',
  [ValidateSet('Cancel', 'Suspend', 'Resume')] [string] $Kind,
  [ValidateSet('ACTIVE', 'SUSPENDED', 'CLOSED')] [string] $Expect = 'ACTIVE',
  [string] $Ont = 'ALCLB3D9363D', [string] $OntModel = 'G-2425G-B',
  [switch] $CleanSchedules
)
$ErrorActionPreference = 'Stop'
# This repo, and the NetSuite suite folder (helpers\netsuite\suite-dir.ts): NS_SUITE_DIR, else the QC workspace's
# test-cases\netsuite two levels up, else the copy in this repo (netsuite-suite\).
$repo = $PSScriptRoot
$workspaceSuite = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\test-cases\netsuite'))
$suite = if ($env:NS_SUITE_DIR) { $env:NS_SUITE_DIR } elseif (Test-Path $workspaceSuite) { $workspaceSuite } else { Join-Path $repo 'netsuite-suite' }
$tools = Join-Path $suite 'tools'
# the date every step puts the clock back to: 2027-01-01, or NS_BASELINE when the team has moved it
$baseline = if ($env:NS_BASELINE) { $env:NS_BASELINE } else { '2027-01-01' }
if ($Ont -eq 'ALCLB3A97FBA') { throw "Never Kiet's ONT" }

function Clock([string] $d) { $c = node "$tools\clock.js" set $d; Write-Host "  clock $c" -ForegroundColor DarkGray }
# Tool output goes to the host, never into a function's return value.
function Tool { & node @args | ForEach-Object { Write-Host "  $_" }; if ($LASTEXITCODE) { throw "node $($args -join ' ') failed" } }
# Runs one tests/dev spec with the given env vars for this call only. Exit code ignored: each step checks the result itself.
function Spec([string] $spec, [hashtable] $vars) {
  $saved = @{}
  foreach ($k in $vars.Keys + 'EMBRIX_ENV_FILE') { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
  Push-Location $repo
  try {
    $env:EMBRIX_ENV_FILE = '.env.coopegsbx2'
    foreach ($k in $vars.Keys) { Set-Item "env:$k" $vars[$k] }
    $ErrorActionPreference = 'Continue' # npx writes to stderr; with 2>&1 PowerShell 5.1 would stop on it
    npx playwright test "tests/coopeg/netsuite-actions/$spec" --project=dev --reporter=line 2>&1 | Select-String -Pattern '\[LOG\]|passed|failed' | ForEach-Object { Write-Host "  $_" }
  } finally {
    Pop-Location
    foreach ($k in $saved.Keys) { if ($null -eq $saved[$k]) { Remove-Item "env:$k" -ErrorAction SilentlyContinue } else { Set-Item "env:$k" $saved[$k] } }
  }
}
function AddDays([string] $d, [int] $n) { ([datetime]$d).AddDays($n).ToString('yyyy-MM-dd') }
function Month([string] $d, [int] $n, [int] $day) { ([datetime]$d).AddMonths($n).ToString('yyyy-MM-') + $day.ToString('00') }

# Finish the newest open order of the account at $d: DB step when it waits for provisioning, Submit order, check the subscription.
function Finish([string] $acc, [string] $d, [string] $want) {
  Write-Host "finish $acc at $d -> $want" -ForegroundColor Cyan
  Clock $d
  try {
    $open = node "$tools\order-check.js" open $acc
    if ($open) {
      Write-Host "  open order: $open"
      $id = ($open -split ' ')[0]
      if ($open -match 'PROVISIONING_INITIATED|PROVISIONING_ERROR|CREATED') { Tool "$tools\complete-order.js" $id }
      Spec 'ns-submit-order.spec.ts' @{ NS_SUBMIT_ACCOUNT = $acc; NS_SUBMIT_EXPECT = $want }
    }
    Tool "$tools\order-check.js" sub $acc $want
  } finally { Clock $baseline }
}

function Provision([string] $tag, [string] $d) {
  Write-Host "provision $tag at $d (ONT $Ont)" -ForegroundColor Cyan
  Clock $d
  try {
    $vars = @{ NS_PROV_ONT = $Ont; NS_PROV_ONT_MODEL = $OntModel; NS_PROV_TAGS = $tag; NS_PROV_ONT_CLEARED = 'true'; NS_PROV_GO = 'true'; NS_PROV_DB_COMPLETE = 'true' }
    Spec 'ns-provision.spec.ts' $vars
    $acc = (Get-Content "$repo\test-results\ns-provision.json" -Raw | ConvertFrom-Json).contracts[0].account
  } finally { Clock $baseline }
  if (-not $acc) { throw 'no contract created (see the log above)' }
  Finish $acc $d 'ACTIVE'
  return $acc
}

function Schedule([string] $d) {
  $st = node "$tools\order-check.js" schedule $d
  Write-Host "schedule $d (existing: $st)" -ForegroundColor Cyan
  if ($st -ne 'none' -and $st -ne 'PENDING') { throw "a $st schedule already exists on ${d}: node $tools\clean-schedules.js $d $d --go, then run again" }
  $vars = @{ NS_RUN_DATE = $d; NS_RUN_NO_CONTRACTS = 'true' }
  if ($st -eq 'PENDING') { $vars.NS_RUN_EXISTING = 'true' }
  Spec 'ns-billing-run.spec.ts' $vars # sets and restores the clock itself
  # A slow Core UI load can stop the spec before it creates the schedule (10-27: Operations Hub menu not shown in 5 s): once more.
  if ((node "$tools\order-check.js" schedule $d) -eq 'none') { Write-Host "  no schedule created: once more" -ForegroundColor Yellow; Spec 'ns-billing-run.spec.ts' $vars }
}

function PlaceOrder([string] $acc, [string] $kind, [string] $d, [string] $want) {
  Write-Host "$kind order for $acc at $d" -ForegroundColor Cyan
  Clock $d
  try { Spec 'ns-cancel-order.spec.ts' @{ NS_CANCEL_ACCOUNT = $acc; NS_ORDER_KIND = $kind } } finally { Clock $baseline }
  Finish $acc $d $want
}

# A discount the way Coope's agents add one: Services > Modify > Add Discounts (ns-discount-order.spec.ts), then finish.
function AddDiscount([string] $acc, [string] $offer, [string] $d) {
  Write-Host "discount $offer for $acc at $d" -ForegroundColor Cyan
  Clock $d
  try { Spec 'ns-discount-order.spec.ts' @{ NS_DISC_ACCOUNT = $acc; NS_DISC_OFFER = $offer; NS_DISC_GO = 'true' } } finally { Clock $baseline }
  Finish $acc $d 'ACTIVE'
}

switch ($Step) {
  'provision' { Provision $Tag $Date }
  'discount'  { AddDiscount $Account $Offer $Date }
  'schedule'  { Schedule $Date }
  'order'     { PlaceOrder $Account $Kind $Date $Expect }
  'finish'    { Finish $Account $Date $Expect }
  'full' {
    # One contract through: manual suspend/resume (SUS-001), first invoice (INV-002, REG-001), collection 18/19/21/22 with the
    # suspension completed (REG-002, CAN-002), payment + automatic reconnection, plan change (CHG-001), next invoice, cancellation
    # and the final bill (CAN-001). Start = the 1st of a month whose next 3 months the run may bill.
    if (-not $Start) { throw '-Start <YYYY-MM-01> required' }
    $m1 = Month $Start 1 1; $m2 = Month $Start 2 1; $m3 = Month $Start 3 1
    if ($CleanSchedules) { Tool "$tools\clean-schedules.js" $m1 (AddDays $m3 1) --go }
    $acc = Provision 'N' $Start
    PlaceOrder $acc 'Suspend' (AddDays $Start 9) 'SUSPENDED'
    PlaceOrder $acc 'Resume' (AddDays $Start 19) 'ACTIVE'
    Schedule $m1
    $inv = node "$tools\order-check.js" invoice $acc (Month $Start 1 18)
    if (-not $inv) { throw "no invoice due $(Month $Start 1 18) for $acc" }
    Schedule (Month $Start 1 18); Schedule (Month $Start 1 19); Schedule (Month $Start 1 21)
    Finish $acc (Month $Start 1 21) 'SUSPENDED'
    Schedule (Month $Start 1 22)
    Tool "$tools\pay-invoice.js" $acc $inv (Month $Start 1 24)
    Finish $acc (Month $Start 1 24) 'ACTIVE'
    Tool "$tools\plan-change.js" $acc (Month $Start 1 26)
    Finish $acc (Month $Start 1 26) 'ACTIVE'
    Schedule $m2
    PlaceOrder $acc 'Cancel' (Month $Start 2 10) 'CLOSED'
    Schedule $m3
    Tool "$tools\contract-state.js" $acc --calls
    Write-Host "done: $acc (ONT free again)" -ForegroundColor Green
  }
  'suspended' {
    # Exploration (no suite case yet): how the build bills suspended lines with this environment's settings
    # (stopChargesWhileSuspended, prorateChargesOnReconnection, daysBilledAfterSuspension = 11,
    # fullCycleOnSameCycleReconnection = false). Internet bills in arrears: the schedule of the 1st bills the month before.
    #   M0 manual suspend on the 10th, resume on the 20th    -> billed on M1-01: days of service only? (SUS-001, UAT-08)
    #   M1 collection cut on the 21st, not reconnected        -> billed on M2-01: days before the cut + 11 (UAT-06)
    #   M2 suspended the whole month                          -> billed on M3-01: nothing (UAT-07)
    #   M3 everything paid on the 10th, automatic reconnection -> billed on M4-01: from the 10th (UAT-09, UAT-10)
    #   M4 cancelled on the 5th                                -> billed on M5-01: the 4 days used? (CAN-001)
    if (-not $Start) { throw '-Start <YYYY-MM-01> required' }
    $m1 = Month $Start 1 1; $m2 = Month $Start 2 1; $m3 = Month $Start 3 1; $m4 = Month $Start 4 1; $m5 = Month $Start 5 1
    # clean-schedules takes at most 62 days per call
    if ($CleanSchedules) { Tool "$tools\clean-schedules.js" $m1 (AddDays $m3 -1) --go; Tool "$tools\clean-schedules.js" $m3 (AddDays $m4 1) --go; Tool "$tools\clean-schedules.js" $m5 (AddDays $m5 1) --go }
    # -Account continues a contract an earlier attempt provisioned, suspended and resumed in M0
    if ($Account) { $acc = $Account } else {
      $acc = Provision 'N' $Start
      PlaceOrder $acc 'Suspend' (AddDays $Start 9) 'SUSPENDED'
      PlaceOrder $acc 'Resume' (AddDays $Start 19) 'ACTIVE'
    }
    Schedule $m1
    $inv1 = node "$tools\order-check.js" invoice $acc (Month $Start 1 18)
    if (-not $inv1) { throw "no invoice due $(Month $Start 1 18) for $acc" }
    Schedule (Month $Start 1 18); Schedule (Month $Start 1 19); Schedule (Month $Start 1 21)
    Finish $acc (Month $Start 1 21) 'SUSPENDED'
    Schedule (Month $Start 1 22)
    Schedule $m2
    Schedule $m3
    $inv2 = node "$tools\order-check.js" invoice $acc (Month $Start 2 18)
    $payDay = Month $Start 3 10
    Tool "$tools\pay-invoice.js" $acc $inv1 $payDay
    if ($inv2) { Tool "$tools\pay-invoice.js" $acc $inv2 $payDay }
    Finish $acc $payDay 'ACTIVE'
    Schedule $m4
    PlaceOrder $acc 'Cancel' (Month $Start 4 5) 'CLOSED'
    Schedule $m5
    Tool "$tools\contract-state.js" $acc
    Write-Host "done: $acc (compare the bills with the comment above)" -ForegroundColor Green
  }
}
