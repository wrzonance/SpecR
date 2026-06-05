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
$ProgressPreference = 'SilentlyContinue'   # Get-Download prints its own progress
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Start-SpecR.bat runs this file as command text (Invoke-Expression) so that
# execution policy can never block it; in that mode $PSScriptRoot is empty and
# the bat supplies the repo root via SPECR_REPO_ROOT instead.
$RepoRoot = if ($PSScriptRoot) {
    Resolve-Path (Join-Path $PSScriptRoot '..\..')
}
elseif ($env:SPECR_REPO_ROOT) {
    Resolve-Path $env:SPECR_REPO_ROOT
}
else {
    throw 'cannot locate the SpecR repo -- launch via Start-SpecR.bat'
}
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

function Write-Note([string]$Message) {
    Write-Host "    $Message" -ForegroundColor Yellow
}

# Streams a download to disk with a live percent counter so the big archives
# (PostgreSQL is ~320 MB) never look like a frozen window.
function Get-Download([string]$Url, [string]$Destination, [string]$What) {
    if (Test-Path $Destination) {
        Write-Ok "$What already downloaded -- using cached $(Split-Path $Destination -Leaf)"
        return
    }
    Write-Note "downloading $What"
    Write-Host "    from $Url" -ForegroundColor DarkGray
    $tmp = "$Destination.partial"
    $response = [System.Net.WebRequest]::Create($Url).GetResponse()
    try {
        $total = $response.ContentLength
        $inStream = $response.GetResponseStream()
        $outStream = [System.IO.File]::Create($tmp)
        try {
            $buffer = New-Object byte[] (1MB)
            $done = [long]0
            $lastPct = -1
            while (($read = $inStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $outStream.Write($buffer, 0, $read)
                $done += $read
                if ($total -gt 0) {
                    $pct = [int](100 * $done / $total)
                    if ($pct -ne $lastPct) {
                        $lastPct = $pct
                        Write-Host -NoNewline ("`r    {0,3}%  {1:N0} / {2:N0} MB" -f $pct, ($done / 1MB), ($total / 1MB))
                    }
                }
                else {
                    Write-Host -NoNewline ("`r    {0:N0} MB" -f ($done / 1MB))
                }
            }
        }
        finally {
            $outStream.Dispose()
            $inStream.Dispose()
        }
    }
    finally {
        $response.Dispose()
    }
    Write-Host ''
    Move-Item $tmp $Destination
    Write-Ok "saved $(Split-Path $Destination -Leaf)"
}

# Runs a native executable, echoing the step and streaming the tool's own
# output line by line. Also tolerates stderr chatter: with
# $ErrorActionPreference = 'Stop', PowerShell 5.1 turns any redirected stderr
# line into a terminating NativeCommandError -- pg_ctl/psql write status text
# to stderr routinely, so native calls go through this wrapper instead.
function Invoke-Native([string]$Label, [scriptblock]$Block) {
    Write-Host "    >> $Label" -ForegroundColor DarkCyan
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Sentinel: if the executable itself is missing, no native command runs,
        # $LASTEXITCODE would keep a stale value from an EARLIER command, and a
        # failure could read as success. 9009 = cmd.exe's "not recognized" code.
        $global:LASTEXITCODE = 9009
        & $Block 2>&1 | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
        return $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

# -- Node.js ------------------------------------------------------------------

# npm's global prefix is where `npm install --global` puts pnpm.cmd. On a
# fresh Node install that folder (%APPDATA%\npm for system Node) is often not
# on the session PATH yet, so we resolve it explicitly after installing.
function Get-NpmGlobalPrefix {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & npm prefix --global 2>$null | Select-Object -First 1
        if ($LASTEXITCODE -eq 0 -and $out) { return ("$out").Trim() }
        return $null
    }
    catch {
        return $null
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

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
        Write-Note "extracting $(Split-Path $zip -Leaf) -> $nodeDir"
        Expand-Archive -Path $zip -DestinationPath $Runtime -Force
        Write-Ok 'extraction complete'
    }
    else {
        Write-Ok "reusing portable Node.js already extracted at $nodeDir"
    }
    $env:PATH = "$nodeDir;$env:PATH"
    Write-Ok "Node.js $(& node --version) (portable) now first on PATH"
}

function Initialize-Node {
    Write-Step 'Checking Node.js (need v22+)'
    if (Test-NodeVersion) {
        Write-Ok "Node.js $(& node --version) found at $((Get-Command node).Source)"
    }
    else {
        Write-Note 'no Node.js v22+ on PATH -- fetching a portable copy'
        Install-PortableNode
    }

    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        Write-Ok "pnpm $(& pnpm --version) found at $((Get-Command pnpm).Source)"
        return
    }

    Write-Note 'pnpm not found -- installing with npm (full npm output follows)'
    $code = Invoke-Native 'npm install --global pnpm' { npm install --global --no-fund pnpm }
    if ($code -ne 0) {
        # System Node without write access to its global prefix -- switch to a
        # portable Node (its directory is user-writable) and retry there.
        Write-Note "npm exited with code $code -- switching to portable Node.js and retrying"
        Install-PortableNode
        $code = Invoke-Native 'npm install --global pnpm (portable Node)' { npm install --global --no-fund pnpm }
    }
    if ($code -ne 0) {
        throw ("could not install pnpm (npm exit code $code) -- scroll up for npm's own error output. " +
            'Common causes: no internet access, a corporate proxy/TLS inspection blocking registry.npmjs.org, ' +
            'or antivirus quarantining npm. Workaround: install pnpm yourself (https://pnpm.io/installation), ' +
            'then re-run this script.')
    }

    # npm succeeded, but pnpm.cmd lives in npm's global prefix, which may not
    # be on this session's PATH yet -- resolve it and put it first.
    $prefixDir = Get-NpmGlobalPrefix
    if ($prefixDir -and (Test-Path (Join-Path $prefixDir 'pnpm.cmd'))) {
        Write-Note "pnpm.cmd found in npm global prefix: $prefixDir (adding to PATH)"
        $env:PATH = "$prefixDir;$env:PATH"
    }
    $installed = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $installed) {
        throw ("npm reported success but pnpm is still not callable (looked on PATH and in '$prefixDir'). " +
            "Open a NEW terminal and run 'pnpm --version' -- if that works, re-run this script from a fresh window.")
    }
    Write-Ok "pnpm $(& pnpm --version) installed at $($installed.Source)"
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
        Write-Note "extracting $(Split-Path $zip -Leaf) -> $(Join-Path $Runtime 'pgsql') (takes a minute)"
        Expand-Archive -Path $zip -DestinationPath $Runtime -Force   # zip contains pgsql\
        Write-Ok 'extraction complete'
    }
    else {
        Write-Ok "reusing portable PostgreSQL already extracted at $pgBin"
    }

    if (-not (Test-Path (Join-Path $pgData 'PG_VERSION'))) {
        $code = Invoke-Native "initdb: create database cluster at $pgData" {
            & (Join-Path $pgBin 'initdb.exe') -D $pgData -U specr -A trust -E UTF8 --locale=C
        }
        if ($code -ne 0) { throw 'initdb failed (note: PostgreSQL refuses to run from an Administrator shell)' }
    }
    else {
        Write-Ok "reusing existing database cluster at $pgData"
    }

    $code = Invoke-Native 'pg_ctl status: is the bundled PostgreSQL already running?' {
        & (Join-Path $pgBin 'pg_ctl.exe') status -D $pgData
    }
    if ($code -ne 0) {
        $code = Invoke-Native "pg_ctl start: launching PostgreSQL on port $PgPort (log: $pgLog)" {
            & (Join-Path $pgBin 'pg_ctl.exe') start -D $pgData -l $pgLog -w -o "-p $PgPort"
        }
        if ($code -ne 0) { throw "pg_ctl start failed -- see $pgLog" }
        $script:StopPgOnExit = $true
    }

    Write-Host "    >> psql: checking whether database 'specr' exists" -ForegroundColor DarkCyan
    $dbExists = & (Join-Path $pgBin 'psql.exe') -h localhost -p $PgPort -U specr -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='specr'"
    if ("$dbExists" -notmatch '1') {
        $code = Invoke-Native "createdb: creating database 'specr'" {
            & (Join-Path $pgBin 'createdb.exe') -h localhost -p $PgPort -U specr specr
        }
        if ($code -ne 0) { throw 'createdb specr failed' }
    }
    else {
        Write-Ok "database 'specr' already exists"
    }

    Write-Ok "PostgreSQL ready on port $PgPort (data: .specr-runtime\pgdata)"
    return "postgresql://specr@localhost:$PgPort/specr"
}

function Stop-Postgres {
    if (-not $script:StopPgOnExit) { return }
    $pgCtl = Join-Path $Runtime 'pgsql\bin\pg_ctl.exe'
    $pgData = Join-Path $Runtime 'pgdata'
    if (Test-Path $pgCtl) {
        Write-Step 'Stopping bundled PostgreSQL'
        Invoke-Native 'pg_ctl stop' { & $pgCtl stop -D $pgData -m fast } | Out-Null
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
    Write-Host "    >> pnpm $($PnpmArgs -join ' ')" -ForegroundColor DarkCyan
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
    Write-Note "environment: PORT=$AppPort NODE_ENV=production DATABASE_URL=$DatabaseUrl"

    Write-Step 'Installing dependencies'
    Invoke-CheckedPnpm 'dependency install' @('install', '--frozen-lockfile')

    Write-Step 'Running database migrations + seeding the CSI section catalog'
    Invoke-CheckedPnpm 'migrations' @('migrate')
    Invoke-CheckedPnpm 'seed' @('seed')

    Write-Step 'Building the server'
    Invoke-CheckedPnpm 'build' @('build')

    Write-Step "Starting SpecR on http://localhost:$AppPort"
    Write-Note 'a browser tab will open as soon as the server answers on the port'
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
    $script:AppExitCode = $LASTEXITCODE
}

# -- Main ---------------------------------------------------------------------

$script:AppExitCode = 0

try {
    Write-Host ''
    Write-Host '  === SpecR -- one-click bootstrap ===' -ForegroundColor White
    Write-Host "  repo:    $RepoRoot"
    Write-Host "  runtime: $Runtime"

    New-Item -ItemType Directory -Path $Runtime -Force | Out-Null

    Initialize-Node
    $databaseUrl = Initialize-Postgres
    Start-SpecR $databaseUrl
}
finally {
    Stop-Postgres
}

# Propagate the server's exit code; required because the bat launches this
# file as command text, where powershell.exe only reports explicit exits.
exit $script:AppExitCode
