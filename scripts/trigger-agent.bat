@echo off
REM Proxies agent execution to the generic modular runner

npx tsx "%~dp0..\src\runner.ts" %*
