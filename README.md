# DevFlow

DevFlow is a local-first development task board and AI-agent orchestration app. It helps you organize projects and tasks, attach repository context, launch coding agents, track agent runs, verify changes locally, and keep the whole workflow on your machine.

The project is Windows-first, but the Node/Vite app can also run on macOS for normal local development.

## What DevFlow Can Do

- **Project and task board**: manage projects, cards, priorities, statuses, checklists, target files, branches, and review flow.
- **AI agent orchestration**: prepare agent-ready prompts and launch configured agents such as Codex, Antigravity, or Claude from a DevFlow card.
- **Agent run tracking**: store queued/running/succeeded/failed/cancelled run history in SQLite and keep prompt/log artifacts under `.devflow/runs/`.
- **Local repository tools**: inspect git status/diff, read local files, apply guarded edits, run verification commands, and create local commits without pushing.
- **MCP server**: expose DevFlow tools to ChatGPT/agents so they can work with projects, tasks, files, git, and verification through one controlled interface.
- **Connector helpers**: centralize external context such as Jira/GitHub configuration into reusable tools when credentials are configured.
- **Skills and prompts**: store reusable authoring/review guidance and prompt templates in SQLite while keeping built-in skill markdown in `skills/`.
- **Backup and restore**: export, backup, restore, and migrate local DevFlow data without requiring an external database server.

## Tech Stack

- TypeScript
- React + Vite frontend
- Express/Node server
- SQLite via `better-sqlite3`
- Model Context Protocol (MCP) server layer
- Local Windows launcher scripts for one-click startup

## Prerequisites

Required:

- Node.js
- npm
- Git

Optional, depending on your workflow:

- `ngrok` only if you want a public tunnel or the one-click `start:all` flow.
- Codex, Antigravity, Claude, or other agent CLIs only if you want DevFlow to launch agents.
- Jira/GitHub credentials only if you want connector-backed context tools.

## Local Setup

For an already cloned repo, the normal local setup is only:

```bash
npm install
npm run setup
npm run dev
```

Then open:

```text
http://localhost:3000
```

`npm run setup` creates the local data/uploads/backups folders, initializes the SQLite schema, and copies `.env.example` to `.env` if `.env` does not already exist.

For a brand-new machine, clone the repo first:

```bash
git clone https://github.com/anusornNeal/dev-flow.git
cd dev-flow
```

Manual `.env` copy is only needed if you want to edit config before running setup:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

## Optional Setup: ngrok and One-Click Startup

You do **not** need ngrok for normal local use. `npm run dev` is enough for `http://localhost:3000`.

Use ngrok only when you want a public URL, external callbacks, or the full one-click startup flow:

- Windows: double-click `Start DevFlow.bat` or `scripts/start-all.bat`.
- macOS: double-click `Start DevFlow.command`.
- Any OS with a terminal: run `npm run start:all`.

`npm run start:all` runs setup, starts the DevFlow server, starts ngrok, and opens the browser. If `DEVFLOW_NGROK_DOMAIN` is set in `.env`, DevFlow uses that static ngrok domain; otherwise it runs `ngrok http 3000`.

Optional ngrok/browser settings:

```env
DEVFLOW_PORT=3000
DEVFLOW_NGROK_DOMAIN="your-static-domain.ngrok-free.dev"
DEVFLOW_OPEN_BROWSER=true
DEVFLOW_OPEN_BROWSER_DELAY_MS=4000
```

## Optional Setup: Agent CLIs and Tokens

You can use DevFlow as a local board without any tokens.

Configure these only when you need agent launching or connector-backed context:

```env
GITHUB_PERSONAL_ACCESS_TOKEN=""
JIRA_BASE_URL=""
JIRA_EMAIL=""
JIRA_API_TOKEN=""
DEVFLOW_AGENT_TRIGGER_SCRIPT="scripts/trigger-agent.bat"
DEVFLOW_AGENT_EXECUTION_MODE="safe"
```

Notes:

- GitHub/Jira tokens are for connector-backed context tools, not basic local task board usage.
- Agent CLI setup is separate from DevFlow setup. Install and authenticate Codex, Antigravity, Claude, or another CLI before asking DevFlow to launch it.
- UI settings can override connector credentials where supported.

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | Create local `data/`, `uploads/`, and backup folders and bootstrap `.env` when safe. |
| `npm run dev` | Start the development server. |
| `npm run start:all` | Optional ngrok flow: run setup, start the server, start ngrok, and open the app. |
| `npm run doctor` | Check Node/npm, env files, SQLite storage, DB initialization, port availability, and project paths. |
| `npm run typecheck` | Run TypeScript no-emit verification. |
| `npm run lint` | Alias for TypeScript no-emit verification. |
| `npm run verify` | Run the repository verification harness. |
| `npm test` | Alias for `npm run verify`. |
| `npm run build` | Build the frontend and server into `dist/`. |
| `npm run start` | Run the built server from `dist/server.js`. |
| `npm run mcp` | Start the DevFlow MCP server entrypoint. |
| `npm run backup` | Create a timestamped local backup. |
| `npm run restore <path>` | Restore from a backup DB or backup bundle. |
| `npm run migrate:json` | Migrate legacy JSON task/project data into SQLite. |

Targeted verification scripts are also available, including `test:gateway`, `test:orchestration`, `test:prompt-templates`, `test:start-all`, `test:sqlite`, `test:import-tasks`, `test:figma`, `test:task-row-persistence`, and `test:dvf-0224`.

## Environment Configuration

Most users can run local DevFlow without editing `.env`. Edit `.env` only for public URL, browser startup behavior, connector credentials, or agent launcher overrides.

- `APP_URL`: external app URL when hosted or tunneled.
- `DEVFLOW_PORT`: local app port, defaulting to `3000` in normal usage.
- `DEVFLOW_NGROK_DOMAIN`, `DEVFLOW_OPEN_BROWSER`, `DEVFLOW_OPEN_BROWSER_DELAY_MS`: optional ngrok/startup behavior.
- `GITHUB_PERSONAL_ACCESS_TOKEN`: optional GitHub connector token fallback.
- `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`: optional Jira connector credential fallback.
- `DEVFLOW_AGENT_TRIGGER_SCRIPT`, `DEVFLOW_AGENT_EXECUTION_MODE`: optional agent launcher behavior.

## Data and Persistence

- SQLite is the runtime source of truth for tasks, projects, skills, settings, and agent runs.
- The default local DB lives under `data/devflow.db`.
- Legacy JSON files are migration inputs/backups only, not active runtime storage.
- No external database server is required.
- Runtime agent artifacts under `.devflow/runs/` are ignored by git.

## Agent Workflow

A typical agent run looks like this:

1. Create or update a DevFlow card with clear scope, target files, acceptance criteria, and verification.
2. Assign an agent/model/effort supported by `config/agents/<agent>.json`.
3. Move the card into an executable status when Auto Work is enabled.
4. DevFlow creates an `agent_runs` record and writes `.devflow/runs/<runId>/prompt.md`.
5. DevFlow launches the configured trigger script, defaulting to `scripts/trigger-agent.bat` unless `DEVFLOW_AGENT_TRIGGER_SCRIPT` is set.
6. The agent works from the prompt and local repo context.
7. DevFlow tracks run status and keeps logs/prompts for inspection.

For repository work through MCP, the recommended safe loop is:

1. Inspect repo context with `get_repo_context_bundle`.
2. Read exact files before editing.
3. Dry-run edits before apply.
4. Inspect git diff.
5. Run targeted verification with `run_project_command`.
6. Dry-run `commit_git_changes`, then commit only intended files.
7. Move the task with `move_task_to_status` when closing or reopening cards.

DevFlow's git tools are intentionally local-only. They do not push, rebase, reset, amend, or checkout branches.

## Backup, Restore, and Migration

- Run `npm run backup` to create a timestamped backup under `data/`.
- Run `npm run restore <path-to-backup>` to restore a `.db` file or backup bundle. Restore asks for confirmation and creates a safety backup first.
- Use the Settings screen export/import flow when moving data between machines.
- Run `npm run migrate:json` only when importing old JSON-based DevFlow data into SQLite.

## Moving to Another Machine

1. Open **Settings** in DevFlow on the old machine.
2. Click **Export Backup** in the Data Management section.
3. Copy the exported backup to the new machine.
4. Clone this repo on the new machine and run `npm install`.
5. Restore through the Settings UI or run `npm run restore <path-to-exported-backup>`.
6. Start DevFlow with `npm run dev` or `npm run start:all`.
