!macro customInit
  ; #3946: external MCP hosts launch QuollDesk.exe with ELECTRON_RUN_AS_NODE=1
  ; via quolldesk-external-mcp.cmd. Those processes can outlive the host UI as
  ; orphans and keep $INSTDIR locked, so the in-app updater hangs (AppHangB1).
  ; Force-kill leftover QuollDesk.exe before files are replaced. Do not pass /T:
  ; electron-updater spawns this installer as a child of the UI QuollDesk.exe,
  ; and /T would terminate the installer itself. Ignore a missing process.
  nsExec::ExecToLog "taskkill /F /IM QuollDesk.exe"
  Pop $0
!macroend

!macro customInstall
  ; Open a selected folder in a new QuollDesk local terminal.
  ; Args go after `--` so Electron/Chromium does not swallow them. Use
  ; `--open-terminal-path="%1."` so paths with spaces stay one token and drive
  ; roots (`C:\`) do not break Windows quote parsing.
  WriteRegStr SHCTX "Software\Classes\Directory\shell\QuollDesk" "MUIVerb" "Open in QuollDesk"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\QuollDesk" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\QuollDesk\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- --open-terminal-path="%1."'

  ; Open the directory currently displayed by Explorer.
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\QuollDesk" "MUIVerb" "Open in QuollDesk"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\QuollDesk" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\QuollDesk\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- --open-terminal-path="%V."'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\QuollDesk"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\QuollDesk"
!macroend
