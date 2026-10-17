@echo off
chcp 65001 >nul
cd /d E:\MyEsp32

rem 用法: flash.bat [固件路径] [COM口]
rem 例:   flash.bat firmware\build\merged-binary.bin COM3

set ESPTOOL=E:\xzserver\tools\esptool\esptool.exe
set FW=%1
if "%FW%"=="" set FW=firmware\build\merged-binary.bin
set PORT=%2
if "%PORT%"=="" set PORT=COM3

if not exist "%ESPTOOL%" goto no_tool
if not exist "%FW%" goto no_fw

echo ============================================================
echo   Flash MyEsp32 firmware    port=%PORT%
echo   %FW%
echo ============================================================
echo   Step 1 erases whole flash. Old firmware will be gone.
echo   If connect fails: hold BOOT, tap RESET, release BOOT.
echo.
pause

echo.
echo [1/2] Erasing ...
"%ESPTOOL%" --chip esp32s3 --port %PORT% erase_flash
if errorlevel 1 goto failed

echo.
echo [2/2] Writing ...
"%ESPTOOL%" --chip esp32s3 --port %PORT% --baud 921600 --before default_reset --after hard_reset write_flash -z 0x0 "%FW%"
if errorlevel 1 goto failed

echo.
echo [OK] Done. Board rebooting.
goto end

:no_tool
echo [error] esptool not found: %ESPTOOL%
goto end

:no_fw
echo [error] firmware not found: %FW%
echo         Build on GitHub Actions first, download merged-binary.bin
goto end

:failed
echo [FAILED] see error above.
echo          - check COM port
echo          - hold BOOT + tap RESET, retry
echo          - try another USB cable

:end
echo.
pause
