<#
.SYNOPSIS
  Builds PlatformAPI.cfe from the XML dump in ./xml and (optionally) installs it into a test base.

  The XML dump is produced once in the Configurator after the extension objects are created
  (see README.md): Конфигурация -> Расширения конфигурации -> PlatformAPI -> Выгрузить в файлы -> ./xml.
  After that, BSL changes go into ./src, are copied into ./xml by this script, and the .cfe is rebuilt.

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
if (-not (Test-Path $xml)) { throw "No XML dump in $xml yet: create the extension once in the Configurator (README.md) and dump it there." }

if (-not $Platform) {
    $Platform = Get-ChildItem "C:\Program Files\1cv8" -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName "bin\1cv8.exe" }
}
if (-not (Test-Path $Platform)) { throw "1cv8.exe not found; pass -Platform" }

# BSL sources -> the module files of the dump.
foreach ($module in Get-ChildItem (Join-Path $here "src\CommonModules") -Filter *.bsl) {
    $target = Join-Path $xml "CommonModules\$($module.BaseName)\Ext\Module.bsl"
    if (-not (Test-Path $target)) { throw "$target is missing: add the common module $($module.BaseName) in the Configurator first" }
    Copy-Item $module.FullName $target -Force
}

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
