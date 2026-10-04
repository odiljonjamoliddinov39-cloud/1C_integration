<#
.SYNOPSIS
  Builds PlatformAPI.cfe from ./xml (generated from ./src by build-xml.mjs) with the 1C platform and
  (optionally) installs it into a test base.

  powershell -ExecutionPolicy Bypass -File build.ps1 -Base "D:\Bases\TEST_CRYSTAL" -User Admin [-Install]
#>
param(
    [Parameter(Mandatory = $true)][string]$Base,
    [string]$User = "",
    [string]$Password = $env:ONEC_PASSWORD,
    [string]$Platform = "",
    [switch]$Install
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$xml = Join-Path $here "xml"
& node (Join-Path $here "build-xml.mjs")
if ($LASTEXITCODE -ne 0) { throw "build-xml.mjs failed" }

if (-not $Platform) {
    $Platform = Get-ChildItem "C:\Program Files\1cv8" -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName "bin\1cv8.exe" }
}
if (-not (Test-Path $Platform)) { throw "1cv8.exe not found; pass -Platform" }

$auth = @("/F", $Base)
if ($User) { $auth += @("/N", $User) }
if ($Password) { $auth += @("/P", $Password) }
$log = Join-Path $here "build.log"
$out = Join-Path $here "PlatformAPI.cfe"

& $Platform DESIGNER @auth /DisableStartupDialogs /Out $log /LoadConfigFromFiles $xml -Extension PlatformAPI | Out-Null
if ($LASTEXITCODE -ne 0) { Get-Content $log; throw "LoadConfigFromFiles failed" }
& $Platform DESIGNER @auth /DisableStartupDialogs /Out $log /DumpCfg $out -Extension PlatformAPI | Out-Null
if ($LASTEXITCODE -ne 0) { Get-Content $log; throw "DumpCfg failed" }
Write-Host "Built $out"

if ($Install) {
    & $Platform DESIGNER @auth /DisableStartupDialogs /Out $log /UpdateDBCfg -Extension PlatformAPI | Out-Null
    if ($LASTEXITCODE -ne 0) { Get-Content $log; throw "UpdateDBCfg failed" }
    Write-Host "Installed into $Base"
}
