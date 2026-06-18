@echo off
setlocal
set "SPECR_EXAMPLE_ROOT=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SPECR_EXAMPLE_ROOT%scripts\windows\Start-SpecR.ps1"
if errorlevel 1 (
  echo.
  echo SpecR demo failed to start. Review the messages above.
  pause
)
