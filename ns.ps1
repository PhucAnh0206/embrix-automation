# ns.ps1 -- run NetSuite cases (coopegsbx2) with one command.
#
#   .\ns.ps1 INV-003                 one case
#   .\ns.ps1 AR-001 AR-003 -Headed   several cases, browser visible (only screen cases open one)
#   .\ns.ps1 billing                 a whole area: smoke, billing, customer, inbound, credits, screens, exempt, basics
#   .\ns.ps1 billing -SlowMo 500     slower clicks (ms between actions)
#
# Uses .env.coopegsbx2 for THIS run only (the shared .env and other terminals are untouched), its own
# output folder, and the same one-run-per-tenant lock as run-projects.ps1.
param(
  [Parameter(Mandatory, Position = 0, ValueFromRemainingArguments)] [string[]] $Case,
  [switch] $Headed,
  [int] $SlowMo = 0
)

$areas = [ordered]@{
  smoke    = 'ENV-004', 'AR-003', 'AUTH-004'
  billing  = 'INV-003', 'RET-003', 'MAP-006', 'MAP-001', 'MAP-004', 'AUTH-001', 'INV-006', 'INV-009', 'REG-003'
  customer = 'CRM-001', 'CRM-005', 'CRM-004'
  inbound  = 'AR-001', 'AR-003', 'AR-004', 'PAY-001'
  credits  = 'ENG-006-01', 'CRN-001', 'CRN-010'
  # '~' = a raw pattern: CRN-008 also names the ns-03 credit check; here only the PDF screen check.
  screens  = 'INV-005', '~reports.*CRN-008:'
  exempt   = 'MAP-002'
}
$areas.basics = $areas.smoke + $areas.billing + $areas.customer + $areas.inbound + $areas.credits + $areas.screens + $areas.exempt

$ids = foreach ($c in $Case) { if ($areas.Contains($c.ToLower())) { $areas[$c.ToLower()] } else { $c.ToUpper() } }
# Test titles start with "<id>:", so "INV-003:" never also picks INV-0030 or a longer id.
$grep = ($ids | ForEach-Object { if ($_.StartsWith('~')) { $_.Substring(1) } else { [regex]::Escape($_) + ':' } }) -join '|'
$ids = $ids | ForEach-Object { $_ -replace '^~.*?(\w+-\d+):$', '$1' }

# This repo, wherever it is checked out.
$repo = $PSScriptRoot
$lock = Join-Path $repo '.run-lock.coopegsbx2'
if (Test-Path $lock) {
  $owner = (Get-Content $lock -Raw).Trim()
  if (Get-Process -Id ($owner -split ' ')[0] -ErrorAction SilentlyContinue) {
    Write-Host "coopegsbx2 is already running ($owner). Wait for it to finish." -ForegroundColor Yellow
    return
  }
}

$json = Join-Path $repo '.ns-last-run.json'
$saved = @{ EMBRIX_ENV_FILE = $env:EMBRIX_ENV_FILE; PW_SLOWMO = $env:PW_SLOWMO; PLAYWRIGHT_JSON_OUTPUT_NAME = $env:PLAYWRIGHT_JSON_OUTPUT_NAME; PLAYWRIGHT_HTML_OPEN = $env:PLAYWRIGHT_HTML_OPEN }
Push-Location $repo
try {
  "$PID ns.ps1 $(Get-Date -Format 'HH:mm')" | Set-Content $lock
  $env:EMBRIX_ENV_FILE = '.env.coopegsbx2'
  $env:PLAYWRIGHT_JSON_OUTPUT_NAME = $json
  $env:PLAYWRIGHT_HTML_OPEN = 'never'
  if ($SlowMo) { $env:PW_SLOWMO = "$SlowMo" }
  Remove-Item $json -ErrorAction SilentlyContinue
  Write-Host "NetSuite (coopegsbx2): $($ids -join ', ')" -ForegroundColor Cyan
  # ns-08 / ns-98 are the NetSuite-side checks: they need a person to sign in to NetSuite first, so not here.
  $pw = @('playwright', 'test', '--project=netsuite', '--workers=1', '--output=test-results-coopegsbx2',
          '--reporter=list,html,json,./reporters/netsuite-csv.reporter.ts', '--grep', $grep, 'regression/netsuite/ns-0[0-7]')
  if ($Headed) { $pw += '--headed' }
  & npx @pw
} finally {
  Remove-Item $lock -ErrorAction SilentlyContinue
  foreach ($k in $saved.Keys) { if ($null -eq $saved[$k]) { Remove-Item "env:$k" -ErrorAction SilentlyContinue } else { Set-Item "env:$k" $saved[$k] } }
  Pop-Location
}

# ── What each case used / created, so it can be shown in Core UI ───────────
if (Test-Path $json) {
  $run = Get-Content $json -Raw -Encoding UTF8 | ConvertFrom-Json
  $rows = New-Object Collections.Generic.List[object]
  function Walk($s) {
    foreach ($sp in $s.specs) {
      foreach ($t in $sp.tests) {
        if ($t.projectName -ne 'netsuite') { continue }
        $last = $t.results | Select-Object -Last 1
        $notes = @($t.annotations) + @($last.annotations) | Where-Object { $_.type -eq 'ns-actual' -or $_.type -eq 'skip' } |
          ForEach-Object { $_.description } | Select-Object -Unique
        $mark = switch ($last.status) { 'passed' { 'PASS' } 'skipped' { 'SKIP' } default { 'FAIL' } }
        $rows.Add([pscustomobject]@{ Id = ($sp.title -split ':')[0]; Mark = $mark; Text = (($notes -join ' | ') -replace '\s+', ' ') })
      }
    }
    foreach ($c in $s.suites) { Walk $c }
  }
  foreach ($s in $run.suites) { Walk $s }
  Write-Host "`nWhat was used / created (show these in Core UI):" -ForegroundColor Cyan
  foreach ($r in $rows) {
    $color = @{ PASS = 'Green'; FAIL = 'Red'; SKIP = 'Yellow' }[$r.Mark]
    $text = if ($r.Text.Length -gt 230) { $r.Text.Substring(0, 230) + '…' } else { $r.Text }
    Write-Host ("  {0,-4} {1,-11} {2}" -f $r.Mark, $r.Id, $text) -ForegroundColor $color
  }
  $all = ($rows | ForEach-Object { $_.Text }) -join ' '
  $accounts = @([regex]::Matches($all, 'QA-ANH-NS-R2-\d+-\w+') | ForEach-Object { $_.Value -replace '-O$', '' }) +
              @(if ($all -match '\b4\d{5}\b|208886') { '208886' }) + @(if ($all -match '3012830') { '3012830' }) | Select-Object -Unique
  if ($accounts) {
    Write-Host "`nOpen in Core UI:" -ForegroundColor Cyan
    foreach ($a in $accounts) { Write-Host "  $a   https://core-ui.coopegsbx2.embrix.org/customers/$a/bills" }
  }
}
