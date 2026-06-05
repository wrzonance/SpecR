# -----------------------------------------------------------------------------
# SpecR one-click bootstrap for Windows 11.
#
# Everything lands in <repo>\.specr-runtime -- portable Node.js and PostgreSQL,
# no admin rights, no system-wide installs, fully removable by deleting that
# one folder. Re-runs reuse whatever is already downloaded.
#
# NOTE: ASCII-only on purpose -- Windows PowerShell 5.1 misreads non-ASCII
# script files unless they carry a UTF-8 BOM.
#
# Overrides (set as environment variables before launching):
#   SPECR_PORT          HTTP port for the server         (default 3000)
#   SPECR_PG_PORT       port for the bundled PostgreSQL  (default 5439)
#   SPECR_DATABASE_URL  use an existing PostgreSQL instead of the bundled one
#   SPECR_NODE_VERSION  portable Node.js version         (default 22.14.0)
#   SPECR_PG_VERSION    portable PostgreSQL version      (default 16.4-1)
# -----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest dramatically faster
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Runtime = Join-Path $RepoRoot '.specr-runtime'
$AppPort = if ($env:SPECR_PORT) { $env:SPECR_PORT } else { '3000' }
$PgPort = if ($env:SPECR_PG_PORT) { $env:SPECR_PG_PORT } else { '5439' }
$NodeVersion = if ($env:SPECR_NODE_VERSION) { $env:SPECR_NODE_VERSION } else { '22.14.0' }
$PgVersion = if ($env:SPECR_PG_VERSION) { $env:SPECR_PG_VERSION } else { '16.4-1' }

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "    $Message" -ForegroundColor Green
}

function Get-Download([string]$Url, [string]$Destination, [string]$What) {
    if (Test-Path $Destination) { return }
    Write-Host "    downloading $What ..." -ForegroundColor Yellow
    Write-Host "    $Url"
    $tmp = "$Destination.partial"
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
    Move-Item $tmp $Destination
}

# Runs a native executable while tolerating stderr chatter. With
# $ErrorActionPreference = 'Stop', PowerShell 5.1 turns any redirected stderr
# line into a terminating NativeCommandError -- pg_ctl/psql write status text
# to stderr routinely, so native calls go through this wrapper instead.
function Invoke-Native([scriptblock]$Block) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Block 2>&1 | ForEach-Object { "$_" } | Out-Null
        return $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

# -- Node.js ------------------------------------------------------------------

function Test-NodeVersion {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    $major = [int]((& node --version).TrimStart('v').Split('.')[0])
    return $major -ge 22
}

function Install-PortableNode {
    $nodeDir = Join-Path $Runtime "node-v$NodeVersion-win-x64"
    if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
        $zip = Join-Path $Runtime "node-v$NodeVersion.zip"
        Get-Download "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $zip "Node.js v$NodeVersion (portable)"
        Expand-Archive -Path $zip -DestinationPath $Runtime -Force
    }
    $env:PATH = "$nodeDir;$env:PATH"
    Write-Ok "Node.js $(& node --version) (portable)"
}

function Initialize-Node {
    Write-Step 'Checking Node.js (need v22+)'
    if (Test-NodeVersion) {
        Write-Ok "Node.js $(& node --version) found on PATH"
    }
    else {
        Install-PortableNode
    }

    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        Write-Ok "pnpm $(& pnpm --version) found on PATH"
        return
    }

    Write-Host '    pnpm not found -- installing ...' -ForegroundColor Yellow
    $code = Invoke-Native { npm install --global --no-fund --loglevel=error pnpm }
    if ($code -ne 0) {
        # System Node without write access to its global prefix -- switch to a
        # portable Node (its directory is user-writable) and retry there.
        Write-Host '    global install failed -- switching to portable Node.js' -ForegroundColor Yellow
        Install-PortableNode
        $code = Invoke-Native { npm install --global --no-fund --loglevel=error pnpm }
        if ($code -ne 0) { throw 'could not install pnpm' }
    }
    Write-Ok "pnpm $(& pnpm --version) installed"
}

# -- PostgreSQL ---------------------------------------------------------------

function Initialize-Postgres {
    Write-Step 'Checking PostgreSQL'

    if ($env:SPECR_DATABASE_URL) {
        Write-Ok 'using existing database: SPECR_DATABASE_URL'
        return $env:SPECR_DATABASE_URL
    }

    $pgBin = Join-Path $Runtime 'pgsql\bin'
    $pgData = Join-Path $Runtime 'pgdata'
    $pgLog = Join-Path $Runtime 'postgres.log'

    if (-not (Test-Path (Join-Path $pgBin 'pg_ctl.exe'))) {
        $zip = Join-Path $Runtime "postgresql-$PgVersion.zip"
        Get-Download "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip" $zip "PostgreSQL $PgVersion (portable, ~320 MB)"
        Write-Host '    extracting PostgreSQL (takes a minute) ...' -ForegroundColor Yellow
        Expand-Archive -Path $zip -DestinationPath $Runtime -Force   # zip contains pgsql\
    }

    if (-not (Test-Path (Join-Path $pgData 'PG_VERSION'))) {
        Write-Host '    initializing database cluster ...' -ForegroundColor Yellow
        $code = Invoke-Native { & (Join-Path $pgBin 'initdb.exe') -D $pgData -U specr -A trust -E UTF8 --locale=C }
        if ($code -ne 0) { throw 'initdb failed (note: PostgreSQL refuses to run from an Administrator shell)' }
    }

    $code = Invoke-Native { & (Join-Path $pgBin 'pg_ctl.exe') status -D $pgData }
    if ($code -ne 0) {
        Write-Host "    starting PostgreSQL on port $PgPort ..." -ForegroundColor Yellow
        $code = Invoke-Native { & (Join-Path $pgBin 'pg_ctl.exe') start -D $pgData -l $pgLog -w -o "-p $PgPort" }
        if ($code -ne 0) { throw "pg_ctl start failed -- see $pgLog" }
        $script:StopPgOnExit = $true
    }

    $dbExists = & (Join-Path $pgBin 'psql.exe') -h localhost -p $PgPort -U specr -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='specr'"
    if ("$dbExists" -notmatch '1') {
        $code = Invoke-Native { & (Join-Path $pgBin 'createdb.exe') -h localhost -p $PgPort -U specr specr }
        if ($code -ne 0) { throw 'createdb specr failed' }
    }

    Write-Ok "PostgreSQL ready on port $PgPort (data: .specr-runtime\pgdata)"
    return "postgresql://specr@localhost:$PgPort/specr"
}

function Stop-Postgres {
    if (-not $script:StopPgOnExit) { return }
    $pgCtl = Join-Path $Runtime 'pgsql\bin\pg_ctl.exe'
    $pgData = Join-Path $Runtime 'pgdata'
    if (Test-Path $pgCtl) {
        Write-Host ''
        Write-Host '==> Stopping bundled PostgreSQL' -ForegroundColor Cyan
        Invoke-Native { & $pgCtl stop -D $pgData -m fast } | Out-Null
    }
}

# -- App build + run ----------------------------------------------------------

function Test-PortBusy([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        return $client.ConnectAsync('127.0.0.1', $Port).Wait(250)
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Invoke-CheckedPnpm([string]$What, [string[]]$PnpmArgs) {
    Write-Host "    pnpm $($PnpmArgs -join ' ')" -ForegroundColor Yellow
    & pnpm @PnpmArgs
    if ($LASTEXITCODE -ne 0) { throw "$What failed (pnpm $($PnpmArgs -join ' '))" }
}

function Start-SpecR([string]$DatabaseUrl) {
    Set-Location $RepoRoot
    if (Test-PortBusy ([int]$AppPort)) {
        throw "port $AppPort is already in use -- close the other program or set SPECR_PORT to a free port and re-run"
    }
    $env:DATABASE_URL = $DatabaseUrl
    $env:NODE_ENV = 'production'
    $env:PORT = $AppPort

    Write-Step 'Installing dependencies'
    Invoke-CheckedPnpm 'dependency install' @('install', '--frozen-lockfile')

    Write-Step 'Running database migrations + seeding the CSI section catalog'
    Invoke-CheckedPnpm 'migrations' @('migrate')
    Invoke-CheckedPnpm 'seed' @('seed')

    Write-Step 'Building the server'
    Invoke-CheckedPnpm 'build' @('build')

    Write-Step "Starting SpecR on http://localhost:$AppPort"
    Write-Host ''
    Write-Host '    +---------------------------------------------------+' -ForegroundColor Green
    Write-Host "    |  SpecR console:  http://localhost:$AppPort             |" -ForegroundColor Green
    Write-Host '    |  Drop .SEC / .DOCX spec sections onto the page.   |' -ForegroundColor Green
    Write-Host '    |  Press Ctrl+C in this window to stop the server.  |' -ForegroundColor Green
    Write-Host '    +---------------------------------------------------+' -ForegroundColor Green
    Write-Host ''

    # Open the browser only once the server actually answers on the port.
    Start-Job -ScriptBlock {
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline) {
            $client = New-Object System.Net.Sockets.TcpClient
            try {
                if ($client.ConnectAsync('127.0.0.1', [int]$using:AppPort).Wait(500)) {
                    Start-Process "http://localhost:$using:AppPort"
                    return
                }
            }
            catch { }
            finally { $client.Dispose() }
            Start-Sleep -Milliseconds 500
        }
    } | Out-Null

    & node dist/index.js
}

# -- Main ---------------------------------------------------------------------

try {
    Write-Host ''
    Write-Host '  === SpecR -- one-click bootstrap ===' -ForegroundColor White
    Write-Host "  repo: $RepoRoot"

    New-Item -ItemType Directory -Path $Runtime -Force | Out-Null

    Initialize-Node
    $databaseUrl = Initialize-Postgres
    Start-SpecR $databaseUrl
}
finally {
    Stop-Postgres
}
