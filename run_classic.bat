@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" call setup_app.bat
".venv\Scripts\python.exe" app.py
if errorlevel 1 pause
