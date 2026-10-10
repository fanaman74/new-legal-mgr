@echo off
rem ==========================================================================
rem  Legal Evidence Manager - double-click to start.
rem  1. Uses Node.js if a recent version is installed; otherwise downloads a
rem     private copy into this folder (.runtime), without admin rights.
rem  2. Installs the application libraries only when missing or outdated.
rem  3. Checks prerequisites and opens the app in your browser. If the app is
rem     already running, it simply reopens the browser page.
rem ==========================================================================
setlocal
title Legal Evidence Manager - setup
cd /d "%~dp0"
set "LOCAL_NODE=%~dp0.runtime\node"

echo ==================================================
echo   Legal Evidence Manager (proof of concept)
echo ==================================================
echo.

rem Prefer this project's private Node.js copy if it exists.
if exist "%LOCAL_NODE%\node.exe" goto use_local_node

where node >nul 2>nul
if not %errorlevel%==0 goto get_node
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=12)?0:1)"
if %errorlevel%==0 goto have_node
echo The installed Node.js is too old for this application.

:get_node
echo Node.js was not found. Downloading a private copy into this folder
echo (about 30 MB; nothing is installed on the computer itself)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-node.ps1"
if errorlevel 1 goto manual_node
if not exist "%LOCAL_NODE%\node.exe" goto manual_node

:use_local_node
set "PATH=%LOCAL_NODE%;%PATH%"
goto have_node

:manual_node
echo.
echo Node.js could not be downloaded automatically. Please install the LTS
echo version from https://nodejs.org/ and then double-click this launcher again.
start "" "https://nodejs.org/en/download"
goto fail

:have_node
node scripts\ensure-deps.mjs
if errorlevel 1 goto fail

echo.
title Legal Evidence Manager - running (close this window to stop)
node node_modules\tsx\dist\cli.mjs scripts\launch.ts %*
if errorlevel 1 goto fail
goto end

:fail
echo.
echo The application could not be started. Read the messages above.
pause
exit /b 1

:end
endlocal
