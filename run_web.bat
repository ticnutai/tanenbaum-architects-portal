@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" call setup_app.bat
start "MAVAT Python" /min ".venv\Scripts\python.exe" web_app.py --no-browser
start "MAVAT Web" /min cmd /c "npm run dev"
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:18474"
