@echo off
rem Thin shim invoked by Tauri's bundler `signCommand` (see tauri.conf.json).
rem It must stay free of single quotes: Tauri embeds the rendered command inside
rem NSIS `!uninstfinalize '<cmd>'`, which is wrapped in single quotes, so any
rem single quote in the command would terminate that string early and break
rem `makensis`. Resolving the PowerShell signer via %~dp0 keeps this working no
rem matter which directory the bundler invokes it from (MSI vs NSIS uninstaller).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\sign-windows-tauri.ps1" -InputPath "%~1"
exit /b %ERRORLEVEL%
