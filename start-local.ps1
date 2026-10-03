# Runs the whole system on this Windows computer, for the testing phase before a server.
# Needs Docker Desktop (running). Usage, in PowerShell at the repo root:
#     powershell -ExecutionPolicy Bypass -File start-local.ps1
# Then open http://localhost:8080. Stop with:  docker compose -f deploy/docker-compose.yml down
# (your data stays; it is kept in Docker volumes).
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "deploy")

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker is not running. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, then run this again." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path ".env")) {
    function New-Secret { -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ }) }
    @"
# Local test setup written by start-local.ps1. Plain HTTP on port 8080, no domain.
DOMAIN=:80
HTTP_PORT=8080
HTTPS_PORT=8443
POSTGRES_PASSWORD=$(New-Secret)
POSTGRES_RO_PASSWORD=$(New-Secret)
SECRET_KEY=$(New-Secret)
ANTHROPIC_API_KEY=
AI_ANONYMIZE_DEFAULT=false
EINVOICE_PROVIDER=stub
"@ | Set-Content -Encoding ascii ".env"
    Write-Host "Wrote deploy\.env with new random passwords."
}

Write-Host "Building and starting (the first time takes a few minutes)..."
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "Waiting for the app..."
for ($i = 0; $i -lt 90; $i++) {
    try { Invoke-WebRequest -UseBasicParsing "http://localhost:8080/api/health" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Seconds 2 }
}

docker compose exec api python -m app.cli ensure-owner

Write-Host ""
Write-Host "Running: http://localhost:8080" -ForegroundColor Green
Write-Host "Connect your 1C: Admin -> Connect a 1C base (address, base name, 1C user, password)."
Write-Host "1C on this same computer: type localhost as the address."
Start-Process "http://localhost:8080"
