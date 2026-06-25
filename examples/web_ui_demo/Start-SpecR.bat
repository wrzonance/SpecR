@echo off
setlocal
set "SPECR_EXAMPLE_ROOT=%~dp0"

rem Prefer PowerShell 7+ (pwsh) when installed: it honors HTTP_PROXY/HTTPS_PROXY
rem env vars and supports -NoProxy, both of which matter behind a corporate
rem proxy. Fall back to Windows PowerShell 5.1 (powershell) otherwise.
set "SPECR_PS=powershell"
where pwsh >nul 2>nul && set "SPECR_PS=pwsh"

"%SPECR_PS%" -NoProfile -ExecutionPolicy Bypass -File "%SPECR_EXAMPLE_ROOT%scripts\windows\Start-SpecR.ps1"
rem Capture the exit code on its own line: inside an if(...) block %errorlevel%
rem expands at parse time, and pause below would otherwise clobber it.
set "ERR=%errorlevel%"
if not "%ERR%"=="0" (
  echo.
  echo SpecR demo failed to start. Review the messages above.
  pause
  exit /b %ERR%
)
