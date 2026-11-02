# ns-demo.ps1 -- NetSuite business demo (coopegsbx2): the main flows in a visible browser, with captions on screen.
#
#   .\ns-demo.ps1            menu: pick a demo (or all)
#   .\ns-demo.ps1 all        run the six demos in a row (about 15 minutes)
#   .\ns-demo.ps1 1          one demo: 1 invoice to NetSuite, 2 extend a due date, 3 payment from NetSuite, 4 void an invoice,
#                            5 monthly billing run (needs the VPN), 6 new contract from CoopeWeb
#   .\ns-demo.ps1 all -Slow  slower clicks and longer captions, for a large audience
#
# Guide for the audience and the presenter: docs\NetSuite\DEMO.md (workspace). Uses .env.coopegsbx2 for this run only.
param(
  [Parameter(Position = 0)] [string] $Demo = '',
  [switch] $Slow
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$names = [ordered]@{
  '1' = 'An invoice goes to NetSuite (and is found there)'
  '2' = 'An agent extends a due date'
  '3' = 'A payment comes from NetSuite'
  '4' = 'Voiding an invoice that is already in NetSuite'
  '5' = 'The monthly billing run (VPN on)'
  '6' = 'A new contract arrives from CoopeWeb'
}
if (-not $Demo) {
  Write-Host ''
  Write-Host '  NetSuite demo (coopegsbx2)' -ForegroundColor Green
  foreach ($k in $names.Keys) { Write-Host "    $k  $($names[$k])" }
  Write-Host '    A  all six, in order (about 15 minutes)'
  Write-Host ''
  $Demo = (Read-Host '  Choose 1 to 6, or A').Trim()
}
$Demo = $Demo.ToLower(); if ($Demo -eq 'a') { $Demo = 'all' }
if ($Demo -ne 'all' -and -not $names.Contains($Demo)) { Write-Host "  Unknown choice '$Demo'." -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Join-Path $repo '.env.coopegsbx2'))) {
  Write-Host '  .env.coopegsbx2 is missing (copy .env.coopegsbx2.example and fill it in).' -ForegroundColor Red; exit 1
}

# One run at a time on this machine (same lock as ns.ps1).
$lock = Join-Path $repo '.run-lock.coopegsbx2'
if (Test-Path $lock) { Write-Host "  Another run is in progress ($((Get-Content $lock -Raw).Trim())). Wait for it to finish." -ForegroundColor Yellow; exit 1 }
"$PID ns-demo.ps1 $(Get-Date -Format 'HH:mm')" | Set-Content $lock

$saved = @{ EMBRIX_ENV_FILE = $env:EMBRIX_ENV_FILE; PW_SLOWMO = $env:PW_SLOWMO; NS_DEMO = $env:NS_DEMO; NS_DEMO_HOLD = $env:NS_DEMO_HOLD }
try {
  Set-Location $repo
  $env:EMBRIX_ENV_FILE = '.env.coopegsbx2'
  $env:NS_DEMO = $Demo
  $env:PW_SLOWMO = if ($Slow) { '700' } else { '350' }
  $env:NS_DEMO_HOLD = if ($Slow) { '8000' } else { '5000' }
  Write-Host ''
  Write-Host "  Starting: $(if ($Demo -eq 'all') { 'all six demos' } else { "demo $Demo, $($names[$Demo])" }). A browser window opens; the green bar at the top explains each step." -ForegroundColor Green
  # Playwright prints warnings on stderr: with 'Stop' Windows PowerShell would treat them as a failure.
  $ErrorActionPreference = 'Continue'
  npx playwright test tests/dev/ns-demo.spec.ts --project=dev --headed --workers=1 --reporter=list
  if ($LASTEXITCODE -eq 0) { Write-Host '  Demo finished.' -ForegroundColor Green }
  else { Write-Host '  The demo stopped on a step (see the message above). Screenshots: test-results\.' -ForegroundColor Yellow }
}
finally {
  foreach ($k in $saved.Keys) { Set-Item "env:$k" $saved[$k] -ErrorAction SilentlyContinue; if ($null -eq $saved[$k]) { Remove-Item "env:$k" -ErrorAction SilentlyContinue } }
  Remove-Item $lock -ErrorAction SilentlyContinue
}
