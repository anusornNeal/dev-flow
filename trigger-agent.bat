@echo off
SET AGENT=%1
SET TASK_ID=%2
SET AGY_EXE=C:\Users\tatar\AppData\Local\agy\bin\agy.exe

REM Strict input validation - only alphanumeric and hyphens allowed
echo %AGENT%| findstr /r "^[a-zA-Z0-9]*$" >nul 2>&1
IF ERRORLEVEL 1 (
  echo [trigger-agent] Invalid agent name: %AGENT%
  exit /b 1
)
echo %TASK_ID%| findstr /r "^[a-zA-Z0-9\-]*$" >nul 2>&1
IF ERRORLEVEL 1 (
  echo [trigger-agent] Invalid task ID: %TASK_ID%
  exit /b 1
)

IF /I "%AGENT%"=="Antigravity" (
  REM Launch Antigravity (agy) with interactive mode so history appears in chat UI
  start "Antigravity Agent" "%AGY_EXE%" -i "You are an AI developer agent. A new task has been assigned to you in Dev Flow. Task ID: %TASK_ID%. Use the Dev Flow MCP tools to: 1) Call list_tasks to read full task details for task ID %TASK_ID%. 2) Work on the task. 3) When done, call move_task with status=ready-for-review and pass header X-Agent-Request: true."
) ELSE IF /I "%AGENT%"=="Codex" (
  REM .cmd files must be invoked via cmd /k so the window stays open
  start "Codex Agent" cmd /k ""%APPDATA%\npm\codex.cmd" "You are an AI developer agent. A new task has been assigned to you in Dev Flow. Task ID: %TASK_ID%. Read the task details from Dev Flow MCP and implement it. When done, move the task to ready-for-review.""
) ELSE IF /I "%AGENT%"=="Claude" (
  REM .cmd files must be invoked via cmd /k so the window stays open
  start "Claude Agent" cmd /k ""%APPDATA%\npm\claude.cmd" -p "You are an AI developer agent. A new task has been assigned to you in Dev Flow. Task ID: %TASK_ID%. Read the task details from Dev Flow MCP and implement it. When done, move the task to ready-for-review.""
) ELSE (
  echo [trigger-agent] Unknown agent: %AGENT%
  exit /b 1
)
