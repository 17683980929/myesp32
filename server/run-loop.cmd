@echo off
rem run-loop.cmd - supervisor: keep the MyEsp32 server running.
rem Launched by a Windows Scheduled Task, so this process has NO console:
rem console close / Ctrl+C events cannot reach it (that killed the server twice).
rem Keep this file PURE ASCII (cp936 mangling safety, same as other .ps1/.cmd here).

cd /d E:\MyEsp32\server

:loop
echo [%date% %time%] node starting >> E:\MyEsp32\firmware\build\supervisor.log
"E:\rea\_tools\node-v24.21.0-win-x64\node.exe" --trace-exit src\index.mjs 1>> E:\MyEsp32\firmware\build\server.log 2>> E:\MyEsp32\firmware\build\server.err.log
echo [%date% %time%] node exited, errorlevel=%errorlevel% >> E:\MyEsp32\firmware\build\supervisor.log

rem ping used as sleep: 'timeout' needs a console (Input redirection error)
ping -n 3 127.0.0.1 >nul
goto loop
