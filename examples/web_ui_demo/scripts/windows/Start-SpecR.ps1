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

# True when the port can be bound — mirrors what the API/demo servers do, so the
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

Write-Host ''
Write-Host "==> Building and starting SpecR API from $RepoRoot" -ForegroundColor Cyan
Set-Location $RepoRoot
$env:DATABASE_URL = $DatabaseUrl
$env:NODE_ENV = if ($env:NODE_ENV) { $env:NODE_ENV } else { 'production' }
$env:PORT = $ApiPort

Invoke-CheckedPnpm @('install', '--frozen-lockfile')
Invoke-CheckedPnpm @('migrate')
Invoke-CheckedPnpm @('seed')
Invoke-CheckedPnpm @('build')

$api = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory $RepoRoot -NoNewWindow -PassThru

try {
    Write-Host ''
    Write-Host "==> Waiting for the SpecR API on http://127.0.0.1:$ApiPort" -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/health" -UseBasicParsing -TimeoutSec 2
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
