@echo off
rem ============================================================
rem  MyEsp32 server - one-click launcher
rem  Double-click to start the server and open the admin page.
rem  Closing this window stops the server.
rem  Keep this file PURE ASCII (cp936 mangling safety).
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0server"

set "ADMIN=http://localhost:8080/admin"

rem --- locate node.exe: prefer the standalone build, fall back to PATH ---
set "NODE="
if exist "E:\rea\_tools\node-v24.21.0-win-x64\node.exe" set "NODE=E:\rea\_tools\node-v24.21.0-win-x64\node.exe"
if not defined NODE for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE (
  echo [x] node.exe not found.
  echo     Install Node.js 20+ or edit the NODE path inside this file.
  pause
  exit /b 1
)

rem --- already running? just open the page ---
netstat -ano | findstr /C:":8080" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [i] Server is already running on 8080 - opening the admin page.
  start "" %ADMIN%
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

rem --- warn when the local TTS backend is down (GPT-SoVITS on 9880) ---
netstat -ano | findstr /C:":9880" | findstr /C:"LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [w] GPT-SoVITS is not listening on 9880.
  echo     Voice test will fall back to cloud. Start it with:
  echo       E:\GPT-SoVITS\start-api.cmd
  echo.
)

echo [i] node    : %NODE%
echo [i] workdir : %CD%
echo [i] starting server, admin page opens in ~5s
echo.

rem --- open the browser after a short delay (ping == sleep) ---
start "" /min cmd /c "ping -n 6 127.0.0.1 >nul & start %ADMIN%"

"%NODE%" src\index.mjs

echo.
echo [!] Server stopped. This window can be closed.
pause >nul
