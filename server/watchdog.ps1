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

    看日志（CMD 里 type 会乱码，用下面这条，务必在 CMD 里也是这一行）：
      powershell -NoProfile -Command "Get-Content C:\myesp32\server\watchdog.log -Tail 20 -Encoding UTF8"

    诊断模式（只打印、不改状态、不写日志）：
      powershell -NoProfile -ExecutionPolicy Bypass -File C:\myesp32\server\watchdog.ps1 -Diag

.NOTES
    - 防抖：连续 2 次检查（约 4 分钟）都连不上才动作，避免「应用并重启」
      那 3 秒的正常空窗被误判。
    - 只测 TCP 连得上与否，不看 HTTP 状态码（401 也说明 Node 活着）。
    - 服务识别必须「路径/服务名真的和本项目有关」才认可。
      旧版用 Name -match 'esp|pet|myesp' 会误命中系统服务 FDResPub
      （Function Discovery Resource Publication 里的 esP），已修正。
    - 记录的启动方式每次动作前都会复核，不可信就重新探测并覆盖，
      所以不需要手工删 watchdog.env.json。
    - PowerShell 5.1 兼容：不用 && / ?? / ?. / 三元运算符。
#>
param(
    [int]$Port = 8080,
    [string]$Root = 'C:\myesp32\server',
    [switch]$Diag
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
        $keep = Get-Content $logFile -Tail 2000 -Encoding UTF8
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

function Wait-Port([int]$p, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $p) { return $true }
        Start-Sleep -Milliseconds 800
    }
    return (Test-Port $p)
}

function Get-Fails {
    if (Test-Path $stateFile) {
        $v = (Get-Content $stateFile -Raw).Trim()
        if ($v -match '^\d+$') { return [int]$v }
    }
    return 0
}

function Get-Saved {
    if (Test-Path $envFile) {
        $raw = Get-Content $envFile -Raw -Encoding UTF8
        if ($raw) { return ($raw | ConvertFrom-Json) }
    }
    return $null
}

# 只有「服务可执行路径里带 index.mjs / run-loop / myesp32」或
# 「服务名以 myesp 开头」才算本项目，svchost / services 一律排除。
function Get-ServiceTarget {
    $hit = Get-CimInstance Win32_Service | Where-Object {
        $pn = [string]$_.PathName
        $nm = [string]$_.Name
        if ($pn -eq '') { return $false }
        if ($pn -match 'svchost\.exe|services\.exe') { return $false }
        if ($pn -match 'index\.mjs|run-loop|myesp32') { return $true }
        if ($nm -match '^myesp') { return $true }
        return $false
    }
    if ($hit) { return @($hit)[0] }
    return $null
}

function Get-TaskTarget([object[]]$Tasks) {
    if (-not $Tasks) {
        try { $Tasks = @(Get-ScheduledTask) } catch { $Tasks = @() }
    }
    $hit = @($Tasks | Where-Object {
        $tn = [string]$_.TaskName
        if ($tn -match 'MyEsp32 Watchdog') { return $false }
        foreach ($a in @($_.Actions)) {
            $ex = [string]$a.Execute
            $ar = [string]$a.Arguments
            $wd = [string]$a.WorkingDirectory
            # 三种写法都算：程序本身就是 run-loop.cmd / 路径里带 myesp32 /
            # 参数里带 index.mjs（MyEsp32 任务的 Actions 是 Execute=run-loop.cmd，
            # Arguments 和 WorkingDirectory 都是空的，只查参数会漏掉）
            if ($ex -match 'index\.mjs|run-loop|myesp32') { return $true }
            if ($ar -match 'index\.mjs|run-loop') { return $true }
            if ($wd -match 'myesp32' -and $ex -match 'node|cmd|powershell') { return $true }
        }
        return $false
    })
    if ($hit.Count -eq 0) { return $null }
    foreach ($t in $hit) {
        if ([string]$t.TaskName -match 'myesp') { return $t }
    }
    return $hit[0]
}

function Get-ProcessTarget {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'index\.mjs' })
    if ($procs.Count -eq 0) { return $null }
    $best = $null
    foreach ($p in $procs) {
        if ($p.CommandLine -match 'myesp32') { $best = $p; break }
    }
    if (-not $best) { $best = $procs[0] }
    $script = 'src\index.mjs'
    $m = [regex]::Match([string]$best.CommandLine, '[A-Za-z]:\\[^"]*index\.mjs')
    if ($m.Success) { $script = $m.Value }
    return @{
        mode   = 'process'
        name   = ''
        exe    = [string]$best.ExecutablePath
        script = $script
        detail = [string]$best.CommandLine
    }
}

function Save-Target {
    $svc = Get-ServiceTarget
    if ($svc) {
        $o = [ordered]@{
            mode     = 'service'
            name     = [string]$svc.Name
            pathname = [string]$svc.PathName
            state    = [string]$svc.State
            saved    = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        }
        ($o | ConvertTo-Json) | Set-Content -Path $envFile -Encoding UTF8
        Write-Log ('记录启动方式：Windows 服务 ' + $o.name + ' | ' + $o.pathname)
        return $true
    }
    $tsk = Get-TaskTarget
    if ($tsk) {
        $o = [ordered]@{
            mode  = 'task'
            name  = [string]$tsk.TaskName
            path  = [string]$tsk.TaskPath
            saved = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        }
        ($o | ConvertTo-Json) | Set-Content -Path $envFile -Encoding UTF8
        Write-Log ('记录启动方式：计划任务 ' + $o.path + $o.name)
        return $true
    }
    $proc = Get-ProcessTarget
    if ($proc) {
        $o = [ordered]@{
            mode   = 'process'
            name   = ''
            exe    = $proc.exe
            script = $proc.script
            detail = $proc.detail
            saved  = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        }
        ($o | ConvertTo-Json) | Set-Content -Path $envFile -Encoding UTF8
        Write-Log ('记录启动方式：进程 ' + $proc.exe + ' ' + $proc.script)
        return $true
    }
    # 探测不到也落一个 none 标记，避免服务正常时每 2 分钟重复探测、重复写日志
    $o = [ordered]@{
        mode  = 'none'
        name  = ''
        saved = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    }
    ($o | ConvertTo-Json) | Set-Content -Path $envFile -Encoding UTF8
    Write-Log '未找到可用启动方式（没有相关 Windows 服务，也没有 index.mjs 的 node 进程）'
    return $false
}

# 复核已记录的方式是否仍然可信；不可信就返回 false，交给 Save-Target 重新探测。
function Test-Target([object]$info) {
    if (-not $info) { return $false }
    if ($info.mode -eq 'service') {
        if (-not $info.name) { return $false }
        $ci = Get-CimInstance Win32_Service -Filter ("Name='" + $info.name + "'")
        if (-not $ci) { return $false }
        $pn = [string]$ci.PathName
        if ($pn -match 'svchost\.exe|services\.exe') { return $false }
        if ($pn -match 'index\.mjs|run-loop|myesp32') { return $true }
        if ([string]$ci.Name -match '^myesp') { return $true }
        return $false
    }
    if ($info.mode -eq 'task') {
        if (-not $info.name) { return $false }
        $t = Get-ScheduledTask -TaskName $info.name -TaskPath ([string]$info.path) -EA SilentlyContinue
        if (-not $t) { return $false }
        return $true
    }
    if ($info.mode -eq 'process') {
        if (-not $info.exe) { return $false }
        if (-not (Test-Path $info.exe)) { return $false }
        return $true
    }
    return $false
}

function Invoke-Restart {
    $info = $null
    if (Test-Path $envFile) {
        $raw = Get-Content $envFile -Raw -Encoding UTF8
        if ($raw) { $info = $raw | ConvertFrom-Json }
    }
    if (-not (Test-Target $info)) {
        if ($info -and $info.mode -and $info.mode -ne 'none') {
            Write-Log ('已记录的启动方式不可信（' + $info.mode + ':' + [string]$info.name + '），重新探测')
        }
        if (-not (Save-Target)) { return $false }
        $info = Get-Content $envFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    if ($info.mode -eq 'service' -and $info.name) {
        $ci = Get-CimInstance Win32_Service -Filter ("Name='" + $info.name + "'")
        $st = [string]$ci.State
        $act = '重启'
        if ($st -eq 'Stopped') { $act = '启动' }
        Write-Log ('服务 ' + $info.name + ' 当前状态=' + $st + '，执行' + $act)
        if ($st -eq 'Stopped') {
            Start-Service -Name $info.name
        } else {
            Restart-Service -Name $info.name -Force
        }
        return $true
    }
    if ($info.mode -eq 'task' -and $info.name) {
        Write-Log ('重启计划任务 ' + [string]$info.path + $info.name)
        Stop-ScheduledTask -TaskName $info.name -TaskPath ([string]$info.path) -EA SilentlyContinue
        Start-Sleep -Milliseconds 800
        Start-ScheduledTask -TaskName $info.name -TaskPath ([string]$info.path)
        return $true
    }
    if ($info.mode -eq 'process' -and $info.exe) {
        Write-Log ('拉起进程：' + $info.exe + ' ' + $info.script)
        $out = Join-Path $Root 'watchdog.stdout.log'
        $err = Join-Path $Root 'watchdog.stderr.log'
        Start-Process -FilePath $info.exe -ArgumentList ('"' + $info.script + '"') `
            -WorkingDirectory $Root -WindowStyle Hidden `
            -RedirectStandardOutput $out -RedirectStandardError $err
        return $true
    }
    Write-Log '没有可用启动方式，本次只告警，不自动重启'
    return $false
}

# ── 诊断模式（只读，不改 state、不写日志）──────────────────────────────
if ($Diag) {
    Write-Output ('Root     : ' + $Root + '  exists=' + (Test-Path $Root))
    Write-Output ('Port     : ' + $Port + '  open=' + (Test-Port $Port))
    Write-Output '--- 监听该端口的进程 ---'
    $found = $false
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -EA SilentlyContinue
    foreach ($c in $conns) {
        $found = $true
        Write-Output ('  pid=' + $c.OwningProcess + '  ' + $c.LocalAddress + ':' + $c.LocalPort)
    }
    if (-not $found) {
        $ns = netstat -ano | Select-String (':' + $Port + '\s')
        if ($ns) { foreach ($l in $ns) { Write-Output ('  ' + $l.ToString().Trim()) } }
        else { Write-Output '  (无进程监听)' }
    }
    Write-Output '--- 识别到的 Windows 服务（严格匹配）---'
    $svc = Get-ServiceTarget
    if ($svc) { Write-Output ('  ' + $svc.Name + ' | ' + $svc.State + ' | ' + $svc.PathName) }
    else { Write-Output '  (无)' }
    Write-Output '--- 识别到的计划任务 ---'
    $tsk = Get-TaskTarget
    if ($tsk) {
        Write-Output ('  ' + [string]$tsk.TaskPath + [string]$tsk.TaskName + ' | ' + [string]$tsk.State)
        foreach ($a in @($tsk.Actions)) {
            Write-Output ('    exec: ' + [string]$a.Execute + ' ' + [string]$a.Arguments)
            Write-Output ('    cwd : ' + [string]$a.WorkingDirectory)
        }
        $lim = [string]$tsk.Settings.ExecutionTimeLimit
        $rc = [string]$tsk.Settings.RestartCount
        Write-Output ('    执行期限: ' + $lim + '   失败重启次数: ' + $rc)
        if ($lim -ne '' -and $lim -ne 'PT0S') {
            Write-Output '    !! 执行期限不是 PT0S：任务跑满这个时长会被计划任务强制结束，'
            Write-Output '       进程被杀时不写任何崩溃日志，表现就是「无声无息消失」'
        }
    } else { Write-Output '  (无)' }
    Write-Output '--- 所有含 index.mjs 的 node 进程 ---'
    $ps = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'index\.mjs' })
    if ($ps.Count -eq 0) { Write-Output '  (无)' }
    foreach ($p in $ps) { Write-Output ('  pid=' + $p.ProcessId + '  ' + $p.CommandLine) }
    Write-Output '--- 已记录启动方式 ---'
    if (Test-Path $envFile) { Write-Output ((Get-Content $envFile -Raw -Encoding UTF8)) }
    else { Write-Output '  (无 watchdog.env.json)' }
    Write-Output ('--- 失败计数: ' + (Get-Fails) + ' ---')
    Write-Output '--- 计划任务 ---'
    $t = schtasks /query /tn "MyEsp32 Watchdog" /fo LIST
    if ($t) { foreach ($l in $t) { Write-Output ('  ' + $l) } } else { Write-Output '  (查询失败，需管理员)' }
    exit 0
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
    # 没记录、或上次探测落空(mode=none)且已过 30 分钟，才重新探测一次。
    # 不无条件重探是因为服务正常时每 2 分钟都会走到这里，探不到会刷满日志。
    $saved = Get-Saved
    $probe = $false
    if (-not $saved) {
        $probe = $true
    } elseif ([string]$saved.mode -eq 'none') {
        $age = 9999
        try { $age = ((Get-Date) - [datetime]::Parse([string]$saved.saved)).TotalMinutes } catch { $age = 9999 }
        if ($age -ge 30) { $probe = $true }
    }
    if ($probe) { Save-Target | Out-Null }
    exit 0
}

$fails = $fails + 1
Set-Content $stateFile ([string]$fails) -Encoding ASCII
Write-Log ($Port.ToString() + ' 无响应，第 ' + $fails + ' 次')

if ($fails -lt 2) { exit 0 }

$ok = Invoke-Restart
if (-not $ok) {
    Write-Log '没有可用启动方式，本次未做任何操作'
    Set-Content $stateFile '1' -Encoding ASCII
    exit 1
}
if (Wait-Port $Port 25) {
    Write-Log ($Port.ToString() + ' 重启后已恢复')
    Set-Content $stateFile '0' -Encoding ASCII
    exit 0
}

Write-Log ($Port.ToString() + ' 重启后仍无响应，下次检查继续处理（不再等 2 次）')
Set-Content $stateFile '1' -Encoding ASCII
exit 1
