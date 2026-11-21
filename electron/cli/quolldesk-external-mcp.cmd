@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_SCRIPT=%SCRIPT_DIR%..\mcp\quolldesk-external-mcp-server.cjs"
set "APP_EXE="

if defined QUOLLDESK_CLI_ELECTRON_EXEC_PATH if exist "%QUOLLDESK_CLI_ELECTRON_EXEC_PATH%" set "APP_EXE=%QUOLLDESK_CLI_ELECTRON_EXEC_PATH%"
if not defined APP_EXE if exist "%SCRIPT_DIR%..\..\..\..\QuollDesk.exe" set "APP_EXE=%SCRIPT_DIR%..\..\..\..\QuollDesk.exe"
if not defined APP_EXE if exist "%SCRIPT_DIR%..\..\..\..\quolldesk.exe" set "APP_EXE=%SCRIPT_DIR%..\..\..\..\quolldesk.exe"

if defined APP_EXE (
  set "ELECTRON_RUN_AS_NODE=1"
  "%APP_EXE%" "%SERVER_SCRIPT%" %*
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if not errorlevel 1 (
  node "%SERVER_SCRIPT%" %*
  exit /b %ERRORLEVEL%
)

echo Failed to locate the bundled QuollDesk runtime for quolldesk-external-mcp. 1>&2
exit /b 1
