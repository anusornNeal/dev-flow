@echo off
SET AGENT=%~1
SET TASK_ID=%~2
SET LOCAL_PATH=%~3
SET MODEL=%~4
SET EFFORT=%~5

REM Resolve AGY_EXE
SET "AGY_EXE="
IF DEFINED DEVFLOW_AGY_EXE (
  IF EXIST "%DEVFLOW_AGY_EXE%" (
    SET "AGY_EXE=%DEVFLOW_AGY_EXE%"
    echo [trigger-agent] Using AGY_EXE from DEVFLOW_AGY_EXE override: "%DEVFLOW_AGY_EXE%"
  ) ELSE (
    echo [trigger-agent] WARNING: DEVFLOW_AGY_EXE is set but file not found: "%DEVFLOW_AGY_EXE%"
  )
)

IF NOT DEFINED AGY_EXE (
  IF EXIST "%LOCALAPPDATA%\agy\bin\agy.exe" (
    SET "AGY_EXE=%LOCALAPPDATA%\agy\bin\agy.exe"
    echo [trigger-agent] Using AGY_EXE from LOCALAPPDATA: "%LOCALAPPDATA%\agy\bin\agy.exe"
  )
)

IF NOT DEFINED AGY_EXE (
  for /f "delims=" %%I in ('where agy 2^>nul') do (
    SET "AGY_EXE=%%I"
    echo [trigger-agent] Using AGY_EXE from PATH: "%%I"
    goto :found_agy
  )
  :found_agy
  REM continue
)

IF /I "%AGENT%"=="Antigravity" (
  IF NOT DEFINED AGY_EXE (
    echo [trigger-agent] ERROR: agy.exe not found.
    echo [trigger-agent] Setup hint: Install Antigravity CLI, or set DEVFLOW_AGY_EXE env var to the full path of agy.exe.
    exit /b 1
  )
)


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

IF NOT "%LOCAL_PATH%"=="" IF NOT "%LOCAL_PATH%"=="none" (
  cd /d "%LOCAL_PATH%"
)

SET "AGENT_PROMPT=You are an AI developer agent. A task has been assigned to you in Dev Flow. Task ID: %TASK_ID%. Step 1: Immediately use the Dev Flow MCP tool to move this task to 'in-progress' status. Step 2: Read the task details. Use model '%MODEL%' and reasoning effort '%EFFORT%'. Step 3: If the task has checklist items or subtasks, use the invoke_subagent tool to call subagents for them, explicitly instructing them to use model '%MODEL%' and effort '%EFFORT%'. Step 4: When done, move the task to 'ready-for-review'. Step 5: Check if there are any other tasks in the 'todo' lane for this project. If there are, pick the oldest one, move it to 'in-progress', work on it, and repeat this loop until no 'todo' tasks remain."

SET "MODEL_FLAG="
IF NOT "%MODEL%"=="" IF NOT "%MODEL%"=="none" (
  SET MODEL_FLAG=--model "%MODEL%"
)

IF /I "%AGENT%"=="Antigravity" (
  REM Launch Antigravity (agy) with interactive mode so history appears in chat UI
  start "Antigravity Agent" "%AGY_EXE%" %MODEL_FLAG% -i "%AGENT_PROMPT%"
) ELSE IF /I "%AGENT%"=="Codex" (
  REM .cmd files must be invoked via cmd /k so the window stays open
  start "Codex Agent" cmd /k ""%APPDATA%\npm\codex.cmd" "%AGENT_PROMPT%""
) ELSE IF /I "%AGENT%"=="Claude" (
  REM .cmd files must be invoked via cmd /k so the window stays open
  start "Claude Agent" cmd /k ""%APPDATA%\npm\claude.cmd" -p "%AGENT_PROMPT%""
) ELSE (
  echo [trigger-agent] Unknown agent: %AGENT%
  exit /b 1
)
