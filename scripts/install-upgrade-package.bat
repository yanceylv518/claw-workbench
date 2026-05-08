@echo off
setlocal
cd /d %~dp0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-upgrade-package.ps1"
if errorlevel 1 (
  echo.
  echo Upgrade failed.
  pause
)
