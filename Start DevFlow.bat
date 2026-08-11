@echo off
cd /d "%~dp0"
start "" wscript.exe "%~dp0scripts\run-server.vbs"
exit /b 0
