@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
node "%~dp0scripts\diagnose-images.mjs" "%~dp0."
set "YINGKE_EXIT=%errorlevel%"
echo.
pause
exit /b %YINGKE_EXIT%
