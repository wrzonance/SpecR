@echo off
rem ----------------------------------------------------------------------
rem  SpecR one-click bootstrap for Windows 11.
rem  Double-click this file. It downloads a portable Node.js + PostgreSQL
rem  runtime (no admin rights, nothing installed system-wide), builds the
rem  server, and opens the demo console in your browser.
rem ----------------------------------------------------------------------
title SpecR

rem The repo path travels via the environment, never interpolated into
rem PowerShell string literals -- spaces, parentheses, and apostrophes in the
rem path (C:\Users\O'Brien\...) are all inert this way.
set "SPECR_REPO_ROOT=%~dp0"

rem Preflight (best-effort): clear Mark-of-the-Web from the script and add a
rem CurrentUser execution-policy exception so Start-SpecR.ps1 also runs when
rem launched directly. -Command is permitted even under a Restricted policy,
rem and any failure here is non-fatal because of the launch technique below.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Unblock-File -LiteralPath (Join-Path $env:SPECR_REPO_ROOT 'scripts\windows\Start-SpecR.ps1') } catch {}; try { Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force } catch {}" >nul 2>&1

rem Launch: read the script text and run it as command text. Command text is
rem not a script file, so execution policy never applies -- this sidesteps
rem "PSSecurityException / UnauthorizedAccess / running scripts is disabled"
rem even when Group Policy enforces Restricted/AllSigned and ignores the
rem -ExecutionPolicy Bypass flag. SPECR_REPO_ROOT replaces $PSScriptRoot,
rem which is empty when the script runs this way.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([System.IO.File]::ReadAllText((Join-Path $env:SPECR_REPO_ROOT 'scripts\windows\Start-SpecR.ps1')))"
if errorlevel 1 (
  echo.
  echo SpecR failed to start. Review the messages above.
  pause
)
