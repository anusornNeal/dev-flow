# DevFlow

DevFlow is a local task board and agent orchestration app for managing projects, cards, and AI-assisted execution from a Windows-first desktop workflow.

## Current Architecture

- Runtime persistence uses SQLite at `data/devflow.db`.
- Legacy JSON files are only migration inputs and backups, not the runtime source of truth.
- On first SQLite startup, DevFlow can migrate old JSON data and keep `.bak` backups.
- The app includes an MCP server layer for task/project operations used by agents and local tooling.

## Run Locally

Prerequisites:

- Node.js
- npm

Setup:

1. Install dependencies with `npm install`.
2. Create a local env file if needed from [`.env.example`](.env.example).
3. Start the app with `npm run dev`.

Standard commands:

- `npm run setup` creates the local `data/` directory when needed and bootstraps `.env` from `.env.example` when safe.
- `npm run start:all` runs setup, starts the DevFlow server, starts ngrok on the DevFlow port, and opens the app in a browser.
- `npm run doctor` checks Node/npm, env file availability, writable SQLite storage, DB initialization, port `3000`, and backed-up project local paths.
- `npm test` runs the lightweight verification flow for this repo (`lint` + `doctor`).
- `npm run dev` starts the DevFlow server in development mode.
- `npm run build` builds the frontend bundle and the Node server output into `dist/`.
- `npm run start` runs the built server from `dist/server.cjs`.
- `npm run lint` runs the TypeScript no-emit verification used in this repo.
- `npm run mcp` starts the DevFlow MCP server entrypoint.

## One-Click Start Flow

This repo keeps a Windows-first startup flow and also includes a Mac-friendly launcher:

- Windows: double-click `Start DevFlow.bat` or `scripts/start-all.bat`.
- Mac: double-click `Start DevFlow.command`.
- Terminal on any OS: run `npm run start:all`.

The one-click flow runs `npm run setup`, starts the local DevFlow server, starts ngrok every time, and opens `http://localhost:3000` in your browser. Set `DEVFLOW_NGROK_DOMAIN` in `.env` to use a static ngrok domain; otherwise it runs `ngrok http 3000`.

Make sure `ngrok` is installed and available in your terminal `PATH` on each machine that uses the one-click flow.

Set `DEVFLOW_AGENT_TRIGGER_SCRIPT` to override the default trigger script path (`scripts/trigger-agent.bat`).

## Persistence Notes

- SQLite is the active source of truth for tasks, projects, skills, and settings.
- Agent execution is tracked in SQLite through `agent_runs`; `task.activeAgent` is derived from active run state for UI compatibility.
- Do not treat `tasks.json` or `projects.json` as active runtime storage.
- Existing `.bak` files are backups created during migration/recovery flows.
- No external database server is required.

## Agent Run Lifecycle

- Moving an assigned task into `todo`, creating an eligible `todo` task, or assigning agent/model/effort to an already eligible `todo` task can trigger Auto Work when enabled.
- DevFlow validates the selected agent/model through `config/agents/<agent>.json` before it creates a run. Invalid combinations fail before a misleading active run is created.
- DevFlow creates an `agent_runs` row, writes the compiled prompt to `.devflow/runs/<runId>/prompt.md`, then launches `scripts/trigger-agent.bat` with a short prompt-file reference.
- Prompt files start with launch metadata: selected agent, DevFlow model label, resolved CLI model id, selected effort, effort handling mode, and execution mode.
- Reasoning effort is passed only through an explicit configured CLI flag. Agents without a verified effort flag use prompt metadata as the fallback; no effort text is appended as a positional CLI argument.
- Codex runs generate `.devflow/runs/<runId>/launch.bat` and start that script in a visible Windows terminal. The script changes into the task project's local path and keeps the terminal open after the Codex process exits.
- Active run statuses are `queued`, `starting`, and `running`; settled statuses are `succeeded`, `failed`, and `cancelled`.
- Trigger failures mark the run `failed` and clear the active task lock so the task can be retried.
- Runs older than 30 minutes in an active state are treated as stale and cancelled before new trigger busy checks.
- Moving a task to `ready-for-review` or `done` settles its active run as `succeeded`.
- Use `POST /api/tasks/:id/agent-runs/retry` to retry the latest failed run.
- Use `POST /api/tasks/:id/agent-runs/cancel` to clear an active or stuck run.
- Use `GET /api/tasks/:id/agent-runs` to inspect run history.
- Runtime prompt/log files under `.devflow/runs/` are ignored by git and are not part of normal DB backup/export files.
- The runner uses `DEVFLOW_API_BASE_URL` when it needs an API reference, defaulting to `http://localhost:3000`.
- The runner defaults to safe execution mode. Set `DEVFLOW_AGENT_EXECUTION_MODE=full` only for trusted local full-access runs.
- The previous trigger behavior is documented in [`docs/agent-trigger-legacy-behavior.md`](docs/agent-trigger-legacy-behavior.md).

### Debugging Agent Launches

- Inspect `.devflow/runs/<runId>/agent.log` for cwd, executable source, argv preview, prompt path, launch script path, model mapping, effort handling, execution mode, and errors.
- For Codex, inspect `.devflow/runs/<runId>/launch.bat` to confirm the working directory and resolved executable/arguments.
- If launch fails before terminal handoff, the run should be `failed` with an error message. If a detached process is stuck, cancel it with `POST /api/tasks/:id/agent-runs/cancel`.
- Run artifacts intentionally avoid writing GitHub/Jira token values or secret environment values.

## Skills

- Project skill markdown lives under [`skills/`](skills).
- Runtime skill data should be read through the app/API and stored in SQLite, not assumed to come directly from markdown files after import.
- Skill markdown content should be preserved exactly when imported or displayed.

## Backup and Restore

- **Initial Seed**: On fresh SQLite DB creation, only built-in master skills are seeded. No custom skills or sample data are initialized.
- **Backup**: Run `npm run backup` to create a timestamped backup of the current DB in `data/`.
- **Restore**: Run `npm run restore <path-to-backup-db>`. It requires explicit confirmation and creates a safety backup of your current DB before restoring.

## Migrating to Another Machine

To move your DevFlow local setup to another computer:
1. Open **Settings** in DevFlow on your old machine.
2. Click **Export Backup** in the Data Management section to download a portable `.db` file (secrets like GitHub/Jira tokens are safely excluded).
3. Copy the downloaded `.db` file to your new machine.
4. Clone the repository on the new machine, run `npm install`, and start DevFlow.
5. Either replace `data/devflow.db` with the exported file manually, or run `npm run restore <path-to-exported-db>` to load your data.
