@echo off
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0"
title Personal Workbench

set "PW_FORCE_BUILD="
set "PW_CHECK_ONLY="

if /i "%~1"=="--help" goto :help
if /i "%~1"=="-h" goto :help
if /i "%~1"=="/?" goto :help
if /i "%~1"=="--build" set "PW_FORCE_BUILD=1"
if /i "%~1"=="--check" set "PW_CHECK_ONLY=1"
if not "%~1"=="" if not defined PW_FORCE_BUILD if not defined PW_CHECK_ONLY goto :unknown_argument
if not "%~2"=="" goto :unknown_argument

echo.
echo ============================================================
echo  Personal Workbench
echo ============================================================
echo.

where node.exe >nul 2>nul
if errorlevel 1 goto :missing_node

where npm.cmd >nul 2>nul
if errorlevel 1 goto :missing_npm

for /f "usebackq delims=" %%V in (`node -p "process.versions.node"`) do set "PW_NODE_VERSION=%%V"
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)"
if errorlevel 1 goto :old_node

if not exist "package.json" goto :wrong_directory
if not exist "package-lock.json" goto :wrong_directory

node "scripts\workbench-start-state.mjs" dependencies
if errorlevel 1 (
	echo [1/3] Installing locked dependencies...
	call npm ci --ignore-scripts --cache ".npm-cache"
	if errorlevel 1 goto :failed
	node "scripts\workbench-start-state.mjs" record-dependencies
	if errorlevel 1 goto :failed
) else (
	echo [1/3] Dependencies are ready.
)

if not exist "packages\ai\src\models.generated.ts" goto :hydrate_models
if not exist "packages\ai\src\image-models.generated.ts" goto :hydrate_models
node "packages\ai\scripts\check-model-data.ts" >nul 2>nul
if errorlevel 1 goto :hydrate_models
echo [2/3] Model catalog is ready.
goto :models_ready

:hydrate_models
echo [2/3] Restoring the generated model catalog...
call npm run hydrate:model-data
if errorlevel 1 goto :failed

:models_ready
if defined PW_FORCE_BUILD goto :build
node "scripts\workbench-start-state.mjs" build
if errorlevel 1 goto :build
if not exist "packages\workbench-runtime\dist\index.js" goto :build
if not exist "packages\workbench-core\dist\index.js" goto :build
if not exist "packages\workbench-database\dist\index.js" goto :build
if not exist "packages\workbench-runtime-pi\dist\index.js" goto :build
if not exist "packages\workbench-ui\dist\index.html" goto :build
if not exist "packages\workbench-server\dist\cli.js" goto :build
echo [3/3] Workbench build is ready.
goto :ready

:build
echo [3/3] Building Pi and Personal Workbench...
call npm run build:offline
if errorlevel 1 goto :failed
node "scripts\workbench-start-state.mjs" record-build
if errorlevel 1 goto :failed

:ready
if defined PW_CHECK_ONLY (
	echo.
	echo Environment check passed with Node.js %PW_NODE_VERSION%.
	exit /b 0
)

if defined PERSONAL_WORKBENCH_HOME (
	set "PW_DISPLAY_HOME=%PERSONAL_WORKBENCH_HOME%"
) else (
	set "PW_DISPLAY_HOME=%USERPROFILE%\.personal-workbench"
)
if defined PERSONAL_WORKBENCH_PORT (
	set "PW_DISPLAY_PORT=%PERSONAL_WORKBENCH_PORT%"
) else (
	set "PW_DISPLAY_PORT=4242 preferred, automatic fallback if unavailable"
)

echo.
echo Data: %PW_DISPLAY_HOME%
echo Port: %PW_DISPLAY_PORT%
echo.
echo Open the one-time Personal Workbench URL printed below in your browser.
echo Keep this window open. Press Ctrl+C here to stop Workbench cleanly.
echo.

node "packages\workbench-server\dist\cli.js"
set "PW_EXIT_CODE=%ERRORLEVEL%"
if not "%PW_EXIT_CODE%"=="0" goto :server_failed
exit /b 0

:help
echo Usage: start.bat [--build ^| --check ^| --help]
echo.
echo   no option   Prepare missing dependencies/build output and start Workbench.
echo   --build     Rebuild Pi and Workbench before starting.
echo   --check     Prepare missing files and verify the environment without starting.
echo   --help      Show this help.
echo.
echo Optional environment variables:
echo   PERSONAL_WORKBENCH_HOME   Data root. Default: %%USERPROFILE%%\.personal-workbench
echo   PERSONAL_WORKBENCH_PORT   Loopback port. Default: 4242 with automatic fallback. Use 0 for a free port.
echo   PI_CODING_AGENT_DIR       Existing Pi credential/profile directory.
exit /b 0

:unknown_argument
echo ERROR: Unknown argument.
echo.
goto :help_error

:missing_node
echo ERROR: Node.js was not found in PATH. Install Node.js 22.19 or newer.
goto :failed

:missing_npm
echo ERROR: npm was not found in PATH. Install npm with Node.js.
goto :failed

:old_node
echo ERROR: Node.js %PW_NODE_VERSION% is too old. Personal Workbench requires Node.js 22.19 or newer.
goto :failed

:wrong_directory
echo ERROR: start.bat must remain in the Pi repository root beside package.json.
goto :failed

:server_failed
echo.
echo ERROR: Personal Workbench stopped with exit code %PW_EXIT_CODE%.
echo See the message above and docs\workbench\OPERATIONS.md for troubleshooting.
goto :failed_with_code

:help_error
call :help
exit /b 2

:failed
set "PW_EXIT_CODE=1"

:failed_with_code
echo.
if not defined CI pause
exit /b %PW_EXIT_CODE%
