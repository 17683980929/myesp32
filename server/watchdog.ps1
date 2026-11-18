<#
.SYNOPSIS
    MyEsp32 服务端外部看门狗（单次检查版，由 Windows 计划任务每 2 分钟触发）

.WHY
    服务端进程被外部硬杀 / 整机冻结时：
      - crash.log 里没有 exit / uncaughtException / rss-limit / stall
      - 进程内的任何 watchdog 都随进程一起消失
      - NSSM / run-loop 在正常退出时 3 秒就能拉起，但硬杀时可能数小时不拉起
    所以需要一个完全独立于 Node 的检查：只探测 8080 端口能否连上，
    连不上就重启服务或重新拉起 node。用「单次检查 + 计划任务」而不是常驻循环，
    因为常驻脚本自己也可能被同一个事件干掉。

.USAGE
    把本文件放到 C:\myesp32\server\watchdog.ps1，然后（管理员 CMD）：

      schtasks /create /tn "MyEsp32 Watchdog" ^
        /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\myesp32\server\watchdog.ps1" ^
        /sc minute /mo 2 /ru SYSTEM /rl HIGHEST /f

      schtasks /run /tn "MyEsp32 Watchdog"
      type C:\myesp32\server\watchdog.log

    首次运行若服务正常，会自动记录「启动方式」到 watchdog.env.json：
      - 找到 Windows 服务  -> 之后用 Restart-Service
      - 没服务但有 node   -> 记下 exe 和脚本路径，之后用 Start-Process 拉起
    日志 watchdog.log 已注册进管理页「运维 -> 运行日志」。

.NOTES
    - 防抖：连续 2 次检查（约 4 分钟）都连不上才动作，避免「应用并重启」
      那 3 秒的正常空窗被误判。
    - 只测 TCP 连得上与否，不看 HTTP 状态码（401 也说明 Node 活着）。
    - PowerShell 5.1 兼容：不用 && / ?? / ?. / 三元运算符。
#>
param(
    [int]$Port = 8080,
    [string]$Root = 'C:\myesp32\server'
)

$ErrorActionPreference = 'SilentlyContinue'
$stateFile = Join-Path $Root 'watchdog.state'
$envFile   = Join-Path $Root 'watchdog.env.json'
$logFile   = Join-Path $Root 'watchdog.log'

function Write-Log([string]$msg) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    $f = Get-Item $logFile
    if ($f -and $f.Length -gt 524288) {
        $keep = Get-Content $logFile -Tail 2000
        Set-Content -Path $logFile -Value $keep -Encoding UTF8
    }
}

function Test-Port([int]$p) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(2000, $false)) { return $false }
        $client.EndConnect($ar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Get-Fails {
    if (Test-Path $stateFile) {
        $v = (Get-Content $stateFile -Raw).Trim()
        if ($v -match '^\d+$') { return [int]$v }
    }
    return 0
}

function Save-LaunchInfo {
    $svc = Get-CimInstance Win32_Service |
        Where-Object { $_.Name -match 'esp|pet|myesp' -or $_.PathName -match 'index\.mjs|run-loop' } |
        Select-Object -First 1
    if ($svc) {
        $o = @{ mode = 'service'; name = $svc.Name; exe = ''; script = '' }
        $o | ConvertTo-Json | Set-Content $envFile -Encoding UTF8
        Write-Log ('记录启动方式：Windows 服务 ' + $svc.Name)
        return
    }
    $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'index\.mjs' } |
        Select-Object -First 1
    if ($p) {
        $m = [regex]::Match($p.CommandLine, '\S*index\.mjs')
        $script = 'src\index.mjs'
        if ($m.Success) { $script = $m.Value }
        $o = @{ mode = 'process'; name = ''; exe = $p.ExecutablePath; script = $script }
        $o | ConvertTo-Json | Set-Content $envFile -Encoding UTF8
        Write-Log ('记录启动方式：' + $p.ExecutablePath + ' ' + $script)
    }
}

function Invoke-Restart {
    $info = $null
    if (Test-Path $envFile) {
        $info = Get-Content $envFile -Raw | ConvertFrom-Json
    }
    if ($info -and $info.mode -eq 'service' -and $info.name) {
        Write-Log ('重启服务 ' + $info.name)
        Restart-Service -Name $info.name -Force -ErrorAction SilentlyContinue
        return
    }
    if ($info -and $info.mode -eq 'process' -and $info.exe -and (Test-Path $info.exe)) {
        Write-Log ('拉起 node：' + $info.exe + ' ' + $info.script)
        $out = Join-Path $Root 'watchdog.stdout.log'
        $err = Join-Path $Root 'watchdog.stderr.log'
        Start-Process -FilePath $info.exe -ArgumentList $info.script `
            -WorkingDirectory $Root -WindowStyle Hidden `
            -RedirectStandardOutput $out -RedirectStandardError $err
        return
    }
    Write-Log '没有记录启动方式，本次只告警，不自动重启'
}

# ── 主逻辑 ──────────────────────────────────────────────────────────
if (-not (Test-Path $Root)) {
    Write-Log ('目录不存在：' + $Root)
    exit 1
}

$fails = Get-Fails

if (Test-Port $Port) {
    if ($fails -ge 2) { Write-Log ('服务已恢复（此前连续失败 ' + $fails + ' 次）') }
    Set-Content $stateFile '0' -Encoding ASCII
    if (-not (Test-Path $envFile)) { Save-LaunchInfo }
    exit 0
}

$fails = $fails + 1
Set-Content $stateFile ([string]$fails) -Encoding ASCII
Write-Log ('8080 无响应，第 ' + $fails + ' 次')

if ($fails -lt 2) { exit 0 }

Invoke-Restart
Set-Content $stateFile '0' -Encoding ASCII
