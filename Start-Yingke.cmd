@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
node "%~dp0scripts\manage.mjs" start --open
set "YINGKE_EXIT=%errorlevel%"
echo.
pause
exit /b %YINGKE_EXIT%
