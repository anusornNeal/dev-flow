@echo off
title Dev Flow Server
echo ==========================================
echo Starting Dev Flow Project...
echo ==========================================
cd /d "%~dp0.."

echo Waiting for server to start before opening browser...
start "" /b cmd /c "timeout /t 4 /nobreak > NUL && start http://localhost:3000"

npm run dev
pause
