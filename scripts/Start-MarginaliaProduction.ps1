[CmdletBinding()]
param(
    [ValidateRange(30, 600)]
    [int]$HealthTimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot "docker-compose.prod.yml"
$environmentFile = Join-Path $repoRoot ".env.production"

if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw "Create .env.production from .env.production.example first."
}
$keys = @{}
Get-Content -LiteralPath $environmentFile | ForEach-Object {
    if ($_ -match "^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
        $keys[$matches[1]] = $matches[2].Trim()
    }
}
foreach ($required in @("TUNNEL_TOKEN", "CORS_ORIGINS", "ALLOWED_HOSTS")) {
    if (-not $keys[$required] -or $keys[$required] -like "replace-*") {
        throw "$required is missing from .env.production."
    }
}
if ($keys["CORS_ORIGINS"] -ne "https://read.zengziyang.com") {
    throw "CORS_ORIGINS must be exactly https://read.zengziyang.com in production."
}
if (($keys["ALLOWED_HOSTS"] -split ",").Trim() -notcontains "read.zengziyang.com") {
    throw "ALLOWED_HOSTS must include read.zengziyang.com."
}

& docker info | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is not ready."
}
& docker compose -f $composeFile config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Production Compose validation failed."
}
$previousBuildKit = $env:DOCKER_BUILDKIT
$env:DOCKER_BUILDKIT = "0"
try {
    & docker compose -f $composeFile build api
}
finally {
    $env:DOCKER_BUILDKIT = $previousBuildKit
}
if ($LASTEXITCODE -ne 0) {
    throw "Production API image build failed."
}
& docker compose -f $composeFile up -d --no-build
if ($LASTEXITCODE -ne 0) {
    throw "Production Compose startup failed."
}

$deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
do {
    $apiId = (& docker compose -f $composeFile ps -q api).Trim()
    if ($apiId) {
        $health = (& docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" $apiId).Trim()
        if ($health -eq "healthy") {
            break
        }
    }
    Start-Sleep -Seconds 3
} while ((Get-Date) -lt $deadline)

if ($health -ne "healthy") {
    & docker compose -f $composeFile logs --tail 80 api
    throw "Marginalia API did not become healthy within $HealthTimeoutSeconds seconds."
}

$publishedPorts = & docker compose -f $composeFile port api 8720
if ($publishedPorts) {
    throw "Security check failed: API port 8720 is published as $publishedPorts"
}
$nonLoopbackListeners = @(
    Get-NetTCPConnection -State Listen -LocalPort 8720 -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") }
)
if ($nonLoopbackListeners) {
    $addresses = ($nonLoopbackListeners.LocalAddress | Sort-Object -Unique) -join ", "
    throw "Security check failed: host port 8720 is still reachable on $addresses. Remove the legacy listener or portproxy after Tunnel cutover."
}

Write-Output "Marginalia production API is healthy and port 8720 is not published."
& docker compose -f $composeFile ps
& docker compose -f $composeFile logs --tail 20 cloudflared
