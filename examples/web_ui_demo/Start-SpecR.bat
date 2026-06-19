@echo off
setlocal
set "SPECR_EXAMPLE_ROOT=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SPECR_EXAMPLE_ROOT%scripts\windows\Start-SpecR.ps1"
rem Capture the exit code on its own line: inside an if(...) block %errorlevel%
rem expands at parse time, and pause below would otherwise clobber it.
set "ERR=%errorlevel%"
if not "%ERR%"=="0" (
  echo.
  echo SpecR demo failed to start. Review the messages above.
  pause
  exit /b %ERR%
)
