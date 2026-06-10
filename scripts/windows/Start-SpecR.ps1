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
#   SPECR_PORT          HTTP port for the server  (default 3000, bumps if busy)
#   SPECR_PG_PORT       port for the bundled PostgreSQL  (default 5439)
#   SPECR_DATABASE_URL  use an existing PostgreSQL instead of the bundled one
#   SPECR_NODE_VERSION  portable Node.js version         (default 22.14.0)
#   SPECR_PG_VERSION    portable PostgreSQL version      (default 16.4-1)
#   SPECR_NO_SYSTEM_CA  set to 1 to skip exporting Windows root CAs to Node
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

# Variant of Invoke-Native for commands that spawn a long-running daemon
# (pg_ctl start). The daemon inherits this console's output handles, so a
# PowerShell capture pipeline never sees EOF and blocks forever AFTER the
# launcher itself has exited ('server started' prints, then the script hangs).
# Raw .NET Process.Start with UseShellExecute=$false creates no pipes (output
# still reaches the console), WaitForExit() waits only for the launcher (never
# its descendants), and ExitCode is dependable -- unlike PS 5.1's
# Start-Process -PassThru, whose ExitCode can read $null and turn a clean
# launch into a phantom failure.
function Invoke-NativeUnpiped([string]$Label, [string]$FilePath, [string]$Arguments) {
    Write-Host "    >> $Label" -ForegroundColor DarkCyan
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()
    return $proc.ExitCode
}

# Node ships its own CA bundle and ignores the Windows certificate store.
# Behind a TLS-inspecting proxy or antivirus (corporate root CA installed in
# Windows but unknown to Node), npm/pnpm fail every registry request with
# UNABLE_TO_GET_ISSUER_CERT_LOCALLY and crawl through retries -- while
# PowerShell's own downloads work fine. Exporting the machine's trusted roots
# and handing them to Node via NODE_EXTRA_CA_CERTS fixes that WITHOUT
# disabling TLS verification. Skip with SPECR_NO_SYSTEM_CA=1.
function Export-WindowsCaBundle {
    if ($env:SPECR_NO_SYSTEM_CA) {
        Write-Note 'SPECR_NO_SYSTEM_CA set -- skipping Windows CA export'
        return
    }
    $pem = Join-Path $Runtime 'windows-ca-bundle.pem'
    $builder = New-Object System.Text.StringBuilder
    $count = 0
    foreach ($store in @('Cert:\LocalMachine\Root', 'Cert:\LocalMachine\CA', 'Cert:\CurrentUser\Root', 'Cert:\CurrentUser\CA')) {
        foreach ($cert in (Get-ChildItem $store -ErrorAction SilentlyContinue)) {
            try {
                $base64 = [Convert]::ToBase64String($cert.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)
                $null = $builder.AppendLine('-----BEGIN CERTIFICATE-----')
                $null = $builder.AppendLine($base64)
                $null = $builder.AppendLine('-----END CERTIFICATE-----')
                $count++
            }
            catch { }
        }
    }
    if ($count -gt 0) {
        [System.IO.File]::WriteAllText($pem, $builder.ToString())
        $env:NODE_EXTRA_CA_CERTS = $pem
        Write-Ok "exported $count Windows-trusted CA certificates for Node.js (NODE_EXTRA_CA_CERTS)"
        Write-Note 'this prevents UNABLE_TO_GET_ISSUER_CERT_LOCALLY behind TLS-inspecting proxies/antivirus'
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

# An interrupted earlier run (closed window, killed script) can leave orphaned
# postgres.exe processes from OUR runtime dir holding the port and the data
# dir's shared-memory block, which makes the next pg_ctl start fail. Processes
# whose executable lives under .specr-runtime are ours and safe to stop.
function Stop-OrphanPostgres {
    $mine = Get-Process -Name postgres -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith("$Runtime", [System.StringComparison]::OrdinalIgnoreCase) }
        catch { $false }
    }
    if ($mine) {
        Write-Note "stopping $(@($mine).Count) orphaned postgres.exe process(es) left by an interrupted run"
        $mine | Stop-Process -Force
        Start-Sleep -Seconds 2
    }
}

# Asks the server itself whether it accepts connections. pg_isready exits 0
# when accepting; it spawns no daemon, so a piped call cannot hang.
function Test-PostgresReady([string]$PgBin, [int]$Port) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 2
        & (Join-Path $PgBin 'pg_isready.exe') -q -h localhost -p $Port 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Show-PostgresFailure([string]$PgLogPath, [int]$Code) {
    Write-Host ''
    Write-Host "    pg_ctl start FAILED (exit code $Code) -- diagnostics:" -ForegroundColor Red
    if (Test-Path $PgLogPath) {
        Write-Host "    last 40 lines of ${PgLogPath}:" -ForegroundColor Yellow
        Get-Content $PgLogPath -Tail 40 | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
    }
    else {
        Write-Host '    no postgres.log was written -- postgres.exe likely could not start at all.' -ForegroundColor Yellow
        Write-Host '    Usual cause: missing Microsoft Visual C++ Redistributable. Install it from' -ForegroundColor Yellow
        Write-Host '    https://aka.ms/vs/17/release/vc_redist.x64.exe and re-run this script.' -ForegroundColor Yellow
    }
    Write-Host '    common causes: port in use, leftovers from an interrupted run (a reboot' -ForegroundColor Yellow
    Write-Host '    clears those), antivirus blocking postgres.exe, or an elevated console.' -ForegroundColor Yellow
}

function Initialize-Postgres {
    Write-Step 'Checking PostgreSQL'

    if ($env:SPECR_DATABASE_URL) {
        Write-Ok 'using existing database: SPECR_DATABASE_URL'
        return $env:SPECR_DATABASE_URL
    }

    $pgBin = Join-Path $Runtime 'pgsql\bin'
    $pgData = Join-Path $Runtime 'pgdata'
    $pgLog = Join-Path $Runtime 'postgres.log'
    $port = [int]$PgPort

    if (-not (Test-Path (Join-Path $env:SystemRoot 'System32\vcruntime140.dll'))) {
        Write-Note 'WARNING: vcruntime140.dll not found -- PostgreSQL needs the Microsoft Visual C++'
        Write-Note 'Redistributable (https://aka.ms/vs/17/release/vc_redist.x64.exe) and may fail to start.'
    }

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
        if ($code -ne 0) { throw 'initdb failed -- scroll up for initdb output' }
    }
    else {
        Write-Ok "reusing existing database cluster at $pgData"
    }

    $code = Invoke-Native 'pg_ctl status: is the bundled PostgreSQL already running?' {
        & (Join-Path $pgBin 'pg_ctl.exe') status -D $pgData
    }
    if ($code -eq 0) {
        # Already running -- read the live port from postmaster.pid (4th line),
        # since an earlier run may have started it on a bumped port.
        $pidFile = Join-Path $pgData 'postmaster.pid'
        if (Test-Path $pidFile) {
            $pidLines = @(Get-Content $pidFile)
            if ($pidLines.Count -ge 4 -and "$($pidLines[3])" -match '^\d+$') { $port = [int]$pidLines[3] }
        }
        Write-Ok "bundled PostgreSQL already running on port $port"
    }
    else {
        # An interrupted run can leave our own postgres.exe orphaned, holding
        # the port and the data dir's shared memory -- clear those first, then
        # dodge any FOREIGN listener by bumping to the next free port.
        Stop-OrphanPostgres
        $maxPort = $port + 20
        while ((Test-PortBusy $port) -and ($port -lt $maxPort)) {
            Write-Note "port $port is already in use by another program -- trying $($port + 1)"
            $port++
        }
        if (Test-PortBusy $port) { throw "no free PostgreSQL port in range $PgPort..$maxPort -- set SPECR_PG_PORT" }

        # MUST go through Invoke-NativeUnpiped: capturing pg_ctl start's output
        # hangs the script after 'server started' (daemon inherits the pipe).
        $code = Invoke-NativeUnpiped "pg_ctl start: launching PostgreSQL on port $port (log: $pgLog)" `
            (Join-Path $pgBin 'pg_ctl.exe') `
            ('start -D "{0}" -l "{1}" -w -o "-p {2}"' -f $pgData, $pgLog, $port)

        # The launcher's exit code has proven unreliable (a clean start once
        # reported failure while the log said 'ready to accept connections').
        # The server itself is the source of truth: probe it with pg_isready.
        Write-Note "probing the server with pg_isready (up to 30s) ..."
        $deadline = (Get-Date).AddSeconds(30)
        $ready = $false
        while (-not $ready -and (Get-Date) -lt $deadline) {
            $ready = Test-PostgresReady $pgBin $port
            if (-not $ready) { Start-Sleep -Milliseconds 500 }
        }
        if (-not $ready) {
            Show-PostgresFailure $pgLog ([int]$code)
            throw "PostgreSQL did not become ready on port $port -- full log: $pgLog"
        }
        if ($code -ne 0) {
            Write-Note "note: pg_ctl reported exit code $code, but the server IS accepting connections -- continuing"
        }
        $script:StopPgOnExit = $true
        Write-Ok "(that 'server started' was PostgreSQL -- the SpecR web server starts after the build steps below)"
    }

    Write-Host "    >> psql: checking whether database 'specr' exists" -ForegroundColor DarkCyan
    $dbExists = & (Join-Path $pgBin 'psql.exe') -h localhost -p $port -U specr -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='specr'"
    if ("$dbExists" -notmatch '1') {
        $code = Invoke-Native "createdb: creating database 'specr'" {
            & (Join-Path $pgBin 'createdb.exe') -h localhost -p $port -U specr specr
        }
        if ($code -ne 0) { throw 'createdb specr failed' }
    }
    else {
        Write-Ok "database 'specr' already exists"
    }

    Write-Ok "PostgreSQL ready on port $port (data: .specr-runtime\pgdata)"
    return "postgresql://specr@localhost:$port/specr"
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

    # Settle on a free HTTP port: start at the requested port and walk upward to
    # the first one nothing is listening on, mirroring the PostgreSQL port-bump
    # logic in Initialize-Postgres. Only gives up if the whole range is taken.
    $startPort = [int]$AppPort
    $port = $startPort
    $maxPort = $startPort + 20
    while ((Test-PortBusy $port) -and ($port -lt $maxPort)) {
        Write-Note "port $port is already in use by another program -- trying $($port + 1)"
        $port++
    }
    if (Test-PortBusy $port) {
        throw "no free HTTP port in range $startPort..$maxPort -- set SPECR_PORT to a free port and re-run"
    }
    if ($port -ne $startPort) {
        Write-Ok "using HTTP port $port (port $startPort was busy)"
    }
    $AppPort = "$port"

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

    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Note 'WARNING: this console is elevated (Administrator). PostgreSQL dislikes elevated'
        Write-Note 'consoles -- if database steps fail below, re-run WITHOUT "Run as administrator".'
    }

    New-Item -ItemType Directory -Path $Runtime -Force | Out-Null

    Write-Step 'Preparing TLS trust for Node.js (Windows certificate store export)'
    Export-WindowsCaBundle

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
