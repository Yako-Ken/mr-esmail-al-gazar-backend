<#
.SYNOPSIS
    Runs the 4-Tier Opaque-Box E2E Test Suite for Esmail ElGazar LMS Platform.

.DESCRIPTION
    Preflights Docker/PostgreSQL test database container, sets connection limits,
    and executes the comprehensive 4-tier Jest E2E test suites with structured reporting.

.PARAMETER Tier
    Optional tier filter: 'all', '1', '2', '3', '4'. Defaults to 'all'.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File test/e2e/run-e2e.ps1
    powershell -ExecutionPolicy Bypass -File test/e2e/run-e2e.ps1 -Tier 1
#>

param(
    [ValidateSet('all', '1', '2', '3', '4')]
    [string]$Tier = 'all',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$JestArgs = @()
)

$ErrorActionPreference = 'Continue'
$backendDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $backendDir

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host " Esmail ElGazar LMS - 4-Tier Opaque-Box E2E Test Runner" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "Running from: $(Get-Location)"
Write-Host "Selected Tier: $Tier"

# 1. Preflight database container
$container = 'lms-postgres-test'
$engineUp = $false

docker version --format '{{.Server.Version}}' 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    $engineUp = $true
} else {
    Write-Host "Docker engine not responding. Checking if local PostgreSQL 5432 is open..." -ForegroundColor Yellow
}

if ($engineUp) {
    $state = docker inspect -f '{{.State.Status}}' $container 2>$null
    if ($state -eq 'running') {
        Write-Host "PostgreSQL container '$container' is running." -ForegroundColor Green
    } elseif ($LASTEXITCODE -eq 0) {
        Write-Host "Starting container '$container'..." -ForegroundColor Yellow
        docker start $container | Out-Null
        Start-Sleep -Seconds 3
    }
}

# 2. Configure TEST_DATABASE_URL with robust pool settings
if (-not $env:TEST_DATABASE_URL) {
    $env:TEST_DATABASE_URL = 'postgresql://lms_test:LmsTestOnly_2026@localhost:5432/lms_test?schema=public&connection_limit=20&pool_timeout=30'
}
Write-Host "Using TEST_DATABASE_URL: $env:TEST_DATABASE_URL" -ForegroundColor Gray

# 3. Determine target test files based on Tier
$targetPath = ""
switch ($Tier) {
    '1' { $targetPath = "test/e2e/tier1-features/" }
    '2' { $targetPath = "test/e2e/tier2-boundaries/" }
    '3' { $targetPath = "test/e2e/tier3-combinations/" }
    '4' { $targetPath = "test/e2e/tier4-scenarios/" }
    'all' { $targetPath = "" }
}

# 4. Execute Jest with the dedicated E2E configuration
$configPath = "test/e2e/jest.e2e.config.js"
Write-Host "`nExecuting Jest E2E Suite with config: $configPath`n" -ForegroundColor Cyan

$commandArgs = @(
    "jest",
    "--config", $configPath,
    "--runInBand"
)

if ($targetPath -ne "") {
    $commandArgs += $targetPath
}

if ($JestArgs.Count -gt 0) {
    $commandArgs += $JestArgs
}

npx @commandArgs
$exitCode = $LASTEXITCODE

Pop-Location

Write-Host "`n=================================================================" -ForegroundColor Cyan
if ($exitCode -eq 0) {
    Write-Host " E2E Test Suite Execution Completed Successfully! (Exit Code 0)" -ForegroundColor Green
} else {
    Write-Host " E2E Test Suite Finished with Exit Code: $exitCode" -ForegroundColor Yellow
}
Write-Host "=================================================================`n" -ForegroundColor Cyan

exit $exitCode
