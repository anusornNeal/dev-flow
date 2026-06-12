@echo off
REM Proxies agent execution to the generic modular runner

npx tsx "%~dp0..\src\runner.ts" "%~1" "%~2" "%~3" "%~4" "%~5" "%~6" "%~7" "%~8" "%~9"
