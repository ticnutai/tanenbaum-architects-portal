@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo סביבת Python טרם הותקנה. מפעיל התקנה ראשונית...
  call setup_app.bat
  if errorlevel 1 exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo רכיבי Electron טרם הותקנו. מפעיל התקנה...
  call npm install
  if errorlevel 1 exit /b 1
)
call npm run desktop
if errorlevel 1 pause
