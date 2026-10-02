param([string]$InstallDir = "C:\Program Files\OneCAgent")
$ErrorActionPreference = "Continue"
& "$InstallDir\OneCAgent.exe" stop
Start-Sleep -Seconds 3
& "$InstallDir\OneCAgent.exe" remove
Remove-Item -Recurse -Force $InstallDir
Write-Host "OneCAgent removed (logs in C:\ProgramData\OneCAgent were kept)."
