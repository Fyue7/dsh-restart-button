@echo off
rem dsh-restart-button - desktop fallback entry: double-click this when the UI button is dead.
rem Real work lives in restart-dsh.ps1; this file only lines the arguments up.
rem Keep this file ASCII-only: cmd reads .cmd in the OEM codepage, so UTF-8 CJK turns to mojibake.
setlocal

set "HERE=%~dp0"
set "EXE=E:\DeepSeek Harness\DeepSeek Harness.exe"
set "LOG=%USERPROFILE%\.dsh\dsh-restart-button\restart.log"

if not exist "%EXE%" (
  echo Cannot find DeepSeek Harness.exe at:
  echo   %EXE%
  echo Fix the EXE variable in this file, or tell the plugin the right path.
  pause
  exit /b 1
)

if not exist "%HERE%restart-dsh.ps1" (
  echo Cannot find restart-dsh.ps1 next to this file:
  echo   %HERE%restart-dsh.ps1
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%restart-dsh.ps1" -ExePath "%EXE%" -LogPath "%LOG%" -GraceSeconds 8 -Caller "desktop-fallback"
exit /b %errorlevel%
