<#
.SYNOPSIS
  Installs the 1C Integration Agent as a Windows service. Run in an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File install.ps1 -Exe .\OneCAgent.exe -Config .\agent.ini

  The agent only opens an OUTBOUND connection (wss://) to the backend; no inbound port is opened.
#>
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$Config,
    [string]$InstallDir = "C:\Program Files\OneCAgent",
    [string]$DataDir = "C:\ProgramData\OneCAgent"
)
$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir | Out-Null

$svc = Get-Service -Name OneCAgent -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "Stopping existing service..."
    & "$InstallDir\OneCAgent.exe" stop 2>$null
    Start-Sleep -Seconds 3
}

Copy-Item -Force $Exe "$InstallDir\OneCAgent.exe"
Copy-Item -Force $Config "$InstallDir\agent.ini"

# Tokens live in agent.ini: only Administrators and SYSTEM may read it.
icacls "$InstallDir\agent.ini" /inheritance:r /grant:r "SYSTEM:R" "Administrators:F" | Out-Null

Write-Host "Checking the 1C extension on 127.0.0.1..."
& "$InstallDir\OneCAgent.exe" check
if ($LASTEXITCODE -ne 0) {
    Write-Warning "The extension did not answer /ping. The service is installed anyway; fix agent.ini and restart it."
}

if (-not $svc) {
    & "$InstallDir\OneCAgent.exe" --startup auto install
}
# Restart automatically if it crashes: after 10 s, 30 s, then every 60 s.
sc.exe failure OneCAgent reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
& "$InstallDir\OneCAgent.exe" start
Write-Host "OneCAgent installed and started. Logs: $DataDir"
