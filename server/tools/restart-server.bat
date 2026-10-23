@echo off
rem ============================================================
rem  MyEsp32 server restart helper  (run as Administrator)
rem  Deploy to: C:\myesp32\restart.bat
rem  1) stop the scheduled task
rem  2) kill ONLY node processes running this project
rem  3) verify 8080/8081 are free
rem  4) start the task, wait, show listeners + log tail
rem ============================================================
setlocal
chcp 65001 >nul 2>&1
title MyEsp32 restart

net session >nul 2>&1
if errorlevel 1 (
  echo [X] please run this as Administrator
  pause
  exit /b 1
)

if exist C:\myesp32\server\run-loop.cmd (
  findstr /C:"E:\MyEsp32" C:\myesp32\server\run-loop.cmd >nul 2>&1
  if not errorlevel 1 (
    echo [X] run-loop.cmd still points to E:\MyEsp32 - fix it first
    pause
    exit /b 1
  )
) else (
  echo [X] C:\myesp32\server\run-loop.cmd not found
  pause
  exit /b 1
)

echo [1/5] stopping scheduled task MyEsp32 ...
schtasks /end /tn MyEsp32 >nul 2>&1

echo [2/5] killing node processes of this project only ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'myesp32' }; if (-not $p) { Write-Host '   (none running)' } else { $p | ForEach-Object { Write-Host ('   kill PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }"

ping -n 3 127.0.0.1 >nul

echo [3/5] checking ports 8080 / 8081 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 8080,8081 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize | Out-String | Write-Host; exit 1 } else { Write-Host '   both free'; exit 0 }"
if errorlevel 1 (
  echo [X] port still occupied by another process - check the PIDs above
  echo     do NOT kill other node services blindly ^(3000 / 4444^)
  pause
  exit /b 1
)

echo [4/5] starting scheduled task ...
schtasks /run /tn MyEsp32
ping -n 6 127.0.0.1 >nul

echo [5/5] result
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 8080,8081 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize | Out-String | Write-Host } else { Write-Host '   NOT LISTENING - check C:\myesp32\server\server.log' }"

echo --- server.log tail ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path C:\myesp32\server\server.log) { Get-Content C:\myesp32\server\server.log -Tail 15 } else { Write-Host '   (no log yet)' }"

echo.
echo Done. Press any key to close.
pause >nul
