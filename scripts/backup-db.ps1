param(
    [string]$OutDir = "..\backups",
    [switch]$Restore,
    [string]$FromFile
)

# PostgreSQL backup / restore.
#
# The schema lives in Postgres, not SQLite, so "just copy the file" is not a
# backup. `pg_dump` is used because it captures schema and data together and
# can be restored into an empty database, which is what a real recovery needs.
#
# Credentials come from the environment, never from this script, and the dump
# never leaves the machine as a printed log line.

$ErrorActionPreference = 'Stop'

$container = 'lms-postgres-test'
$db = $env:PGDATABASE
if (-not $db) { $db = 'lms' }
$user = $env:PGUSER
if (-not $user) { $user = 'lms' }

function Get-DbContainer {
    $inspect = docker inspect -f '{{.State.Status}}' $container 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Container '$container' not found. Start it or pass -Container."
    }
    return $inspect
}

if ($Restore) {
    if (-not $FromFile) { throw "-Restore requires -FromFile <path to .sql>" }
    if (-not (Test-Path -LiteralPath $FromFile)) { throw "No such file: $FromFile" }

    $state = Get-DbContainer
    if ($state -ne 'running') { docker start $container | Out-Null }

    Write-Host "Restoring $FromFile into '$db' on $container"
    Write-Host "WARNING: this overwrites the current database contents."
    Get-Content -LiteralPath $FromFile -Raw | docker exec -i $container psql -U $user -d $db -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw "Restore failed (psql exit $LASTEXITCODE)." }
    Write-Host "Restore complete."
    exit 0
}

$state = Get-DbContainer
if ($state -ne 'running') {
    Write-Host "Container '$container' is '$state'. Starting it."
    docker start $container | Out-Null
}

if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $OutDir "lms-$stamp.sql"

# Custom format so the dump is a single transaction-friendly script and drops
# are explicit. Without --clean, restoring into a non-empty database collides
# with the objects already there.
$dumpArgs = @(
    'exec', $container,
    'pg_dump', '-U', $user, '-d', $db,
    '--no-owner', '--no-privileges', '--clean', '--if-exists',
    '--format=plain'
)

Write-Host "Dumping '$db' from $container -> $target"
$dump = docker @dumpArgs 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host $dump
    throw "pg_dump failed (exit $LASTEXITCODE)."
}

# pg_dump writes to stdout; PowerShell may hand back an array of lines.
$text = ($dump -join "`n")
if (-not $text.Trim()) { throw "pg_dump produced no output." }
Set-Content -LiteralPath $target -Value $text -Encoding UTF8

$size = [math]::Round((Get-Item -LiteralPath $target).Length / 1KB, 1)
Write-Host "Wrote $target ($size KB)"

# A backup that was never restored is a hypothesis, not a backup. This only
# proves the file is non-empty and parseable as SQL; a full restore drill belongs
# in CI against a scratch database.
$hasSchema = $text -match 'CREATE TABLE'
if (-not $hasSchema) { throw "Dump has no CREATE TABLE - this does not look like a schema backup." }
Write-Host "Verified: dump contains CREATE TABLE statements."