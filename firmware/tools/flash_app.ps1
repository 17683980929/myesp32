# flash_app.ps1 - flash ONLY the app partition (0x20000), keep NVS (WiFi/server config).
#
# Use for: firmware-only iterations (UI, logic, audio). No re-provisioning needed.
# NOT for: bootloader / partition table / sdkconfig changes - those require a full
#          flash, which erases provisioning (and NVS).
#
# Usage:
#   powershell -File flash_app.ps1 -Zip ..\build\myesp32-merged.zip
#   powershell -File flash_app.ps1 -Zip <zip> -Port COM3
#
# NOTE: keep this file PURE ASCII. Windows PowerShell 5.1 reads BOM-less files as
#       ANSI (cp936 here) and mangles UTF-8: CJK comment bytes can swallow the next
#       newline, merging a comment with the following code line (this happened once:
#       the "$bytes = ..." line was eaten by the comment above it, leaving $bytes
#       null). ASCII-only text is immune to any codepage misinterpretation.
#
# v2026-10: layout v2 (model partition) is out. The merged image is now padded with
#           ~11 MB of 0xFF between app and model, so this app-only slicer against a
#           v2 merged zip writes a lot of padding into the unused ota_1/fatfs area
#           (harmless but slow) and does not bring the model partition. Deploying v2
#           the first time goes through flash_bins.ps1 instead.

param(
    [Parameter(Mandatory = $true)][string]$Zip,
    [string]$Port = "COM3",
    [int]$Baud = 460800,
    [string]$Esptool = "E:\xzserver\tools\esptool\esptool.exe"
)

$ErrorActionPreference = "Stop"

# 1. Extract into firmware\build (git-ignored). Avoid $env:TEMP: in some child
#    shells it is empty and Join-Path then fails outright.
$buildRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'build'
$tmp = Join-Path $buildRoot ("flash-tmp-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Expand-Archive -Path $Zip -DestinationPath $tmp -Force

# 2. Find the app flash offset in flash_args (the "... myesp32.bin" line).
$line = Get-Content (Join-Path $tmp "flash_args") |
    Where-Object { $_ -match '\smyesp32\.bin$' } | Select-Object -First 1
if (-not $line) { throw "myesp32.bin not found in flash_args" }
$offset = ($line.Trim() -split '\s+')[0]
$offsetInt = [Convert]::ToInt32($offset, 16)

# 3. Cut the app slice out of the merged image (offset .. end of file).
$bytes = [IO.File]::ReadAllBytes((Join-Path $tmp "merged-binary.bin"))
$app = [byte[]]::new($bytes.Length - $offsetInt)
[Array]::Copy($bytes, $offsetInt, $app, 0, $app.Length)
$appPath = Join-Path $tmp "app-only.bin"
[IO.File]::WriteAllBytes($appPath, $app)

Write-Host ("app partition: offset={0} size={1} bytes (NVS untouched)" -f $offset, $app.Length)

# 4. Flash.
& $Esptool -p $Port -b $Baud write_flash -z $offset $appPath

Remove-Item $tmp -Recurse -Force
Write-Host "done"
