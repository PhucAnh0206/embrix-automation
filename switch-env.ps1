# switch-env.ps1 -- flip the active .env between environments.
#
# Usage:
#   .\switch-env.ps1 dev        activate .env.dev to .env
#   .\switch-env.ps1 preprod    activate .env.preprod to .env
#   .\switch-env.ps1            show which env is currently active
#
# Convention: keep one .env.NAME file per target environment (git-ignored,
# holds real credentials). The active one is copied to .env, which is what
# Playwright / the tests actually read.

param([string]$Env)

$root = $PSScriptRoot

function Show-Active {
    if (-not (Test-Path "$root\.env")) {
        Write-Host "No active .env. Run: .\switch-env.ps1 [envName]" -ForegroundColor Yellow
        return
    }
    $line = (Select-String -Path "$root\.env" -Pattern '^TEST_ENV=' | Select-Object -First 1).Line
    if ($line) { Write-Host ("Active: " + $line) } else { Write-Host "Active: (TEST_ENV not set)" -ForegroundColor Yellow }
}

if (-not $Env) {
    Show-Active
    return
}

$source = "$root\.env.$Env"
if (-not (Test-Path $source)) {
    Write-Host "No such env file: $source" -ForegroundColor Red
    Write-Host "Available:" -ForegroundColor Yellow
    Get-ChildItem "$root" -Filter ".env.*" | ForEach-Object { "  " + $_.Name }
    exit 1
}

Copy-Item $source "$root\.env" -Force
Write-Host ("Switched to jasec-" + $Env + ". Copied " + $source + " to .env.") -ForegroundColor Green
Show-Active
