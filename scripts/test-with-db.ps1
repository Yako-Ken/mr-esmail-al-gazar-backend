# Ensures Docker engine and the test PostgreSQL are actually up, then runs jest.
#
# Docker Desktop on this machine has died four times mid-session, including once
# in a way that killed the `com.docker.backend` process rather than failing a
# container. Each death cost a full verification cycle: jest exits at
# globalSetup with P1001 and prints nothing useful about the real problem.
#
# This check turns a four-minute rediscovery into a fifteen-second recovery, and
# it distinguishes the two failure modes that look identical from inside jest:
# the daemon being down, and one container being down.

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$JestArgs = @()
)

$ErrorActionPreference = 'Continue'
$container = 'lms-postgres-test'
$engineUp = $false

Write-Host "preflight: docker engine"
for ($i = 0; $i -lt 40; $i++) {
    docker version --format '{{.Server.Version}}' 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $engineUp = $true; break }
    if ($i -eq 0) {
        Write-Host "  engine down, launching Docker Desktop"
        Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
}

if (-not $engineUp) {
    Write-Host "preflight: FAILED - docker engine did not start"
    exit 2
}
Write-Host "  engine up"

$state = docker inspect -f '{{.State.Status}}' $container 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "preflight: FAILED - container $container does not exist"
    exit 2
}

if ($state -ne 'running') {
    Write-Host "  container '$state', starting"
    docker start $container 2>&1 | Out-Null
}

for ($i = 0; $i -lt 30; $i++) {
    $ready = docker exec $container pg_isready -U lms_test -d lms_test 2>&1
    if ($ready -match 'accepting') { break }
    Start-Sleep -Seconds 2
}

if ($ready -notmatch 'accepting') {
    Write-Host "preflight: FAILED - postgres not accepting connections"
    Write-Host "  last: $ready"
    exit 2
}
Write-Host "  postgres accepting"

# Connection headroom for the suite.
#
# There is now one shared PrismaClient (src/config/prisma.ts), but the suite
# deliberately fires concurrent requests at the database — the session-pruning
# race test opens several at once. Prisma's pool is sized from the CPU count
# and connections that cannot be served immediately queue until pool_timeout,
# which surfaces as an intermittent failure that passes alone. Pinning the limit
# makes the queueing explicit and removes that as a source of flakiness.
if (-not $env:TEST_DATABASE_URL) {
    $env:TEST_DATABASE_URL = 'postgresql://lms_test:LmsTestOnly_2026@localhost:5432/lms_test?schema=public&connection_limit=20&pool_timeout=30'
} elseif ($env:TEST_DATABASE_URL -notmatch 'connection_limit') {
    $env:TEST_DATABASE_URL = ($env:TEST_DATABASE_URL -replace '\?schema=public', '?schema=public&connection_limit=20&pool_timeout=30')
}
Write-Host "  pool: connection_limit=20 pool_timeout=30"

Write-Host ""
npx jest @JestArgs
exit $LASTEXITCODE