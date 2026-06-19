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
$ApiPort = if ($env:SPECR_PORT) { $env:SPECR_PORT } else { '3000' }
$WebPort = if ($env:SPECR_WEB_PORT) { $env:SPECR_WEB_PORT } else { '3001' }
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
