@echo off
chcp 65001 >nul
set PROJECT_DIR=%~dp0..
if "%~1"=="" (
  echo Drag an Excel or CSV file onto this shortcut.
  pause
  exit /b 1
)
cd /d "%PROJECT_DIR%"
node scripts\import_and_send.js pickup "%~1"
pause
