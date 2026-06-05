@echo off
rem ----------------------------------------------------------------------
rem  SpecR one-click bootstrap for Windows 11.
rem  Double-click this file. It downloads a portable Node.js + PostgreSQL
rem  runtime (no admin rights, nothing installed system-wide), builds the
rem  server, and opens the demo console in your browser.
rem ----------------------------------------------------------------------
title SpecR
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\Start-SpecR.ps1"
if errorlevel 1 (
  echo.
  echo SpecR failed to start. Review the messages above.
  pause
)
