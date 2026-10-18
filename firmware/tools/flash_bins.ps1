# flash_bins.ps1 - flash layout v2: partition table (0x8000) + app (0x20000) +
# speech model (0xCA0000, ESP-SR wake word "ni hao xiao zhi").
#
# Why a new script: layout v2 added the "model" partition. Deploying it once needs
# the new partition table and srmodels.bin in addition to the app. NVS lives at
# 0x9000 and is NOT touched - no WiFi re-provisioning needed.
#
# The merged-binary.bin artifact is now padded with ~11 MB of 0xFF between the app
# and the model partition. Do NOT use the old "slice app from merged at offset"
# trick as a routine; prefer the myesp32-bins artifact. This script still accepts
# a merged zip as a fallback (it slices the table/model out of it).
#
# Keep this file PURE ASCII (see flash_app.ps1 for the codepage story).
#
# Usage:
#   powershell -File flash_bins.ps1 -Zip <myesp32-bins.zip | myesp32-merged.zip>
#   powershell -File flash_bins.ps1 -Zip <zip> -Port COM3

param(
    [Parameter(Mandatory = $true)][string]$Zip,
    [string]$Port = "COM3",
    [int]$Baud = 460800,
    [string]$Esptool = "E:\xzserver\tools\esptool\esptool.exe"
)

$ErrorActionPreference = "Stop"

$APP_OFFSET   = 0x20000
$TABLE_OFFSET = 0x8000
$MODEL_OFFSET = 0xCA0000

$buildRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'build'
$tmp = Join-Path $buildRoot ("flash-tmp-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Expand-Archive -Path $Zip -DestinationPath $tmp -Force

function Find-Bin([string]$name) {
    $f = Get-ChildItem $tmp -Recurse -File -Filter $name | Select-Object -First 1
    if ($f) { return $f.FullName }
    return $null
}

$tablePath = Find-Bin 'partition-table.bin'
$modelPath = Find-Bin 'srmodels.bin'
$appPath   = $null
$app = Get-ChildItem $tmp -Recurse -File -Filter '*.bin' |
    Where-Object { $_.Name -notmatch 'bootloader|partition-table|ota_data|srmodels|merged' } |
    Select-Object -First 1
if ($app) { $appPath = $app.FullName }

if (-not $tablePath -or -not $modelPath -or -not $appPath) {
    # Fallback: merged image. merged[0x8000..0x9000] is the partition table,
    # merged[APP_OFFSET..MODEL_OFFSET] is the app (plus harmless 0xFF over the
    # unused ota_1/fatfs area), merged[MODEL_OFFSET..EOF] is the model image.
    $merged = Find-Bin 'merged-binary.bin'
    if (-not $merged) { throw "zip has neither the individual bins nor merged-binary.bin" }
    Write-Host "individual bins missing - slicing from merged-binary.bin"
    $bytes = [IO.File]::ReadAllBytes($merged)

    $tablePath = Join-Path $tmp 'table-slice.bin'
    $t = [byte[]]::new(0x1000)
    [Array]::Copy($bytes, $TABLE_OFFSET, $t, 0, 0x1000)
    [IO.File]::WriteAllBytes($tablePath, $t)

    $appPath = Join-Path $tmp 'app-slice.bin'
    $a = [byte[]]::new($MODEL_OFFSET - $APP_OFFSET)
    [Array]::Copy($bytes, $APP_OFFSET, $a, 0, $a.Length)
    [IO.File]::WriteAllBytes($appPath, $a)

    $modelPath = Join-Path $tmp 'model-slice.bin'
    $m = [byte[]]::new($bytes.Length - $MODEL_OFFSET)
    [Array]::Copy($bytes, $MODEL_OFFSET, $m, 0, $m.Length)
    [IO.File]::WriteAllBytes($modelPath, $m)
}

Write-Host ("flashing: table@0x{0:X}  app@0x{1:X}  model@0x{2:X}   (NVS untouched)" -f $TABLE_OFFSET, $APP_OFFSET, $MODEL_OFFSET)
& $Esptool -p $Port -b $Baud write_flash -z $TABLE_OFFSET $tablePath $APP_OFFSET $appPath $MODEL_OFFSET $modelPath
if ($LASTEXITCODE -ne 0) { throw "esptool failed with code $LASTEXITCODE" }

Remove-Item $tmp -Recurse -Force
Write-Host "done"
