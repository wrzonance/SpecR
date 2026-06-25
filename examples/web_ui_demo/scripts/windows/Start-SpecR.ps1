$ErrorActionPreference = 'Stop'

$ExampleRoot = if ($PSScriptRoot) {
    Resolve-Path (Join-Path $PSScriptRoot '..\..')
}
elseif ($env:SPECR_EXAMPLE_ROOT) {
    Resolve-Path $env:SPECR_EXAMPLE_ROOT
}
else {
    throw 'cannot locate examples\web_ui_demo -- launch via Start-SpecR.bat'
}

$RepoRoot = Resolve-Path (Join-Path $ExampleRoot '..\..')

# True when the port can be bound -- mirrors what the API/demo servers do, so the
# result matches whether they will actually be able to listen.
function Test-PortFree([int]$Port) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
    try { $listener.Start(); $listener.Stop(); return $true }
    catch { return $false }
}

# First free port at or after $Start, skipping $Avoid (so the web port never
# lands on the API port). Other dev servers commonly squat 3000+, so we hunt
# for a free port instead of failing on a conflict.
function Find-FreePort([int]$Start, [int]$Avoid = -1) {
    for ($p = $Start; $p -le ($Start + 50); $p++) {
        if ($p -ne $Avoid -and (Test-PortFree $p)) { return $p }
    }
    throw "no free port found at or after $Start"
}

$ApiPortWanted = if ($env:SPECR_PORT) { [int]$env:SPECR_PORT } else { 3000 }
$WebPortWanted = if ($env:SPECR_WEB_PORT) { [int]$env:SPECR_WEB_PORT } else { 3001 }
$ApiPort = Find-FreePort $ApiPortWanted
$WebPort = Find-FreePort $WebPortWanted $ApiPort
if ($ApiPort -ne $ApiPortWanted) {
    Write-Host "==> Port $ApiPortWanted busy; using $ApiPort for the SpecR API" -ForegroundColor Yellow
}
if ($WebPort -ne $WebPortWanted) {
    Write-Host "==> Port $WebPortWanted busy; using $WebPort for the web UI demo" -ForegroundColor Yellow
}
$DatabaseUrl = if ($env:DATABASE_URL) {
    $env:DATABASE_URL
}
else {
    'postgres://specr:specr@localhost:5432/specr'
}

function Invoke-CheckedPnpm([string[]]$PnpmArgs) {
    Write-Host ">> pnpm $($PnpmArgs -join ' ')" -ForegroundColor DarkCyan
    & pnpm @PnpmArgs
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm $($PnpmArgs -join ' ') failed"
    }
}

# --- Corporate-network support ---------------------------------------------
# On a device behind a corporate proxy, `pnpm install` fails two ways:
#   1. it can't reach the registry at all -> ERR_PNPM_META_FETCH_FAIL / fetch failed
#   2. TLS is intercepted (SSL inspection) -> UNABLE_TO_GET_ISSUER_CERT_LOCALLY
# We fix (1) by honoring/discovering the proxy and (2) by trusting the machine's
# own certificate store, which already holds the corporate root CA.

# The configured Windows system proxy as an http://host:port URL, or $null.
# ProxyServer is either a bare "host:port" or per-protocol "http=..;https=..".
function Get-WindowsSystemProxy {
    try {
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
        $settings = Get-ItemProperty -Path $key -ErrorAction Stop
        if ($settings.ProxyEnable -ne 1 -or -not $settings.ProxyServer) { return $null }
        $raw = [string]$settings.ProxyServer
        if ($raw -match '(?:^|;)\s*https=([^;]+)') { $proxy = $Matches[1] }
        elseif ($raw -match '(?:^|;)\s*http=([^;]+)') { $proxy = $Matches[1] }
        elseif ($raw -notmatch '=') { $proxy = $raw }
        else { return $null }
        if ($proxy -notmatch '^[a-z][a-z0-9+.-]*://') { $proxy = "http://$proxy" }
        return $proxy
    }
    catch { return $null }
}

# Writes every trusted root/intermediate CA from the machine to a PEM bundle and
# returns its path. NODE_EXTRA_CA_CERTS *adds* these to Node's built-in roots, so
# public sites keep working while the corporate SSL-inspection root is trusted too.
function Export-MachineCaBundle {
    $bundle = Join-Path ([System.IO.Path]::GetTempPath()) 'specr-corp-ca.pem'
    $stores = @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root',
        'Cert:\LocalMachine\CA', 'Cert:\CurrentUser\CA')
    $certs = Get-ChildItem -Path $stores -ErrorAction SilentlyContinue | Sort-Object Thumbprint -Unique
    if (-not $certs) { return $null }
    $pem = foreach ($cert in $certs) {
        $b64 = [Convert]::ToBase64String($cert.RawData, [Base64FormattingOptions]::InsertLineBreaks)
        "-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----"
    }
    Set-Content -Path $bundle -Value ($pem -join "`n") -Encoding ascii
    return $bundle
}

function Initialize-Network {
    # Proxy: honor an explicit env var first, else fall back to the Windows setting.
    $proxy = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY }
    elseif ($env:HTTP_PROXY) { $env:HTTP_PROXY }
    else { Get-WindowsSystemProxy }
    if ($proxy) {
        Write-Host "==> Using proxy $proxy" -ForegroundColor Yellow
        $env:HTTP_PROXY = $proxy; $env:http_proxy = $proxy
        $env:HTTPS_PROXY = $proxy; $env:https_proxy = $proxy
        # pnpm reads npm config rather than the bare env vars; mirror it there too.
        $env:npm_config_proxy = $proxy
        $env:npm_config_https_proxy = $proxy
    }

    # Never route loopback through the proxy (API health check + web demo calls).
    $noProxy = @('localhost', '127.0.0.1', '::1')
    if ($env:NO_PROXY) { $noProxy += $env:NO_PROXY }
    $env:NO_PROXY = $noProxy -join ','; $env:no_proxy = $env:NO_PROXY
    $env:npm_config_noproxy = $env:NO_PROXY

    # TLS trust. SPECR_INSECURE_TLS is a loud last resort; otherwise respect an
    # explicit cert, then fall back to trusting the machine's own CA store.
    if ($env:SPECR_INSECURE_TLS -eq '1') {
        Write-Host '!! SPECR_INSECURE_TLS=1 -- TLS verification DISABLED. Debug only; never leave this on.' -ForegroundColor Red
        $env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
        return
    }
    if (-not $env:NODE_EXTRA_CA_CERTS -and $env:SPECR_CA_CERT) {
        $env:NODE_EXTRA_CA_CERTS = $env:SPECR_CA_CERT
    }
    if (-not $env:NODE_EXTRA_CA_CERTS) {
        $bundle = Export-MachineCaBundle
        if ($bundle) { $env:NODE_EXTRA_CA_CERTS = $bundle }
    }
    if ($env:NODE_EXTRA_CA_CERTS) {
        Write-Host "==> Trusting CA bundle $($env:NODE_EXTRA_CA_CERTS)" -ForegroundColor DarkGray
    }
}

Write-Host ''
Write-Host "==> Building and starting SpecR API from $RepoRoot" -ForegroundColor Cyan
Set-Location $RepoRoot
$env:DATABASE_URL = $DatabaseUrl
$env:NODE_ENV = if ($env:NODE_ENV) { $env:NODE_ENV } else { 'production' }
$env:PORT = $ApiPort

Initialize-Network

Invoke-CheckedPnpm @('install', '--frozen-lockfile')
Invoke-CheckedPnpm @('migrate')
Invoke-CheckedPnpm @('seed')
Invoke-CheckedPnpm @('build')

$api = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory $RepoRoot -NoNewWindow -PassThru

try {
    Write-Host ''
    Write-Host "==> Waiting for the SpecR API on http://127.0.0.1:$ApiPort" -ForegroundColor Cyan
    # PowerShell 7's Invoke-WebRequest honors HTTP_PROXY, so force a direct
    # connection for the loopback health check (-NoProxy is 6+ only).
    $health = @{ Uri = "http://127.0.0.1:$ApiPort/health"; UseBasicParsing = $true; TimeoutSec = 2 }
    if ($PSVersionTable.PSVersion.Major -ge 6) { $health['NoProxy'] = $true }
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $resp = Invoke-WebRequest @health
            if ($resp.StatusCode -eq 200) { $ready = $true; break }
        }
        catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        throw "SpecR API did not become ready on port $ApiPort after ~30s"
    }

    Write-Host ''
    Write-Host "==> Starting web UI demo from $ExampleRoot" -ForegroundColor Cyan
    Write-Host "    API:  http://127.0.0.1:$ApiPort"
    Write-Host "    Demo: http://127.0.0.1:$WebPort"
    Write-Host ''

    $env:SPECR_API_BASE = "http://127.0.0.1:$ApiPort"
    $env:PORT = $WebPort
    Start-Process "http://127.0.0.1:$WebPort"
    Set-Location $ExampleRoot
    & node server.mjs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    if ($api -and -not $api.HasExited) {
        Stop-Process -Id $api.Id -Force
    }
}
