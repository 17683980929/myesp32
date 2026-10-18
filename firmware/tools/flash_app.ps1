# flash_app.ps1 - 只烧 app 分区（0x20000），保留 NVS 里的 WiFi/服务器配置
#
# 适用：只改了固件代码的迭代（UI、逻辑等）。烧完不用重新配网。
# 不适用：bootloader / 分区表 / sdkconfig 改了的时候 —— 那些必须整包烧
#         （整包烧会清掉配网配置，需要重新配网）。
#
# 用法：
#   powershell -File flash_app.ps1 -Zip ..\build\myesp32-merged.zip
#   powershell -File flash_app.ps1 -Zip <zip> -Port COM3

param(
    [Parameter(Mandatory = $true)][string]$Zip,
    [string]$Port = "COM3",
    [int]$Baud = 460800,
    [string]$Esptool = "E:\xzserver\tools\esptool\esptool.exe"
)

$ErrorActionPreference = "Stop"

# 1. 解包到临时目录
$tmp = Join-Path $env:TEMP ("myesp32-app-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
Expand-Archive -Path $Zip -DestinationPath $tmp -Force

# 2. 从 flash_args 里找 app 的烧录地址（myesp32.bin 那一行）
$line = Get-Content (Join-Path $tmp "flash_args") |
    Where-Object { $_ -match '\smyesp32\.bin$' } | Select-Object -First 1
if (-not $line) { throw "flash_args 里没找到 myesp32.bin" }
$offset = ($line -split '\s+')[0]
$offsetInt = [Convert]::ToInt32($offset, 16)

# 3. 从 merged 镜像里切出 app 部分（该偏移到文件尾）
$bytes = [IO.File]::ReadAllBytes((Join-Path $tmp "merged-binary.bin"))
$app = $bytes[$offsetInt..($bytes.Length - 1)]
$appPath = Join-Path $tmp "app-only.bin"
[IO.File]::WriteAllBytes($appPath, $app)

"app 分区: offset=$offset, size=$($app.Length) bytes（NVS 不动，配置保留）"

# 4. 烧录
& $Esptool -p $Port -b $Baud write_flash -z $offset $appPath

Remove-Item $tmp -Recurse -Force
"完成"
