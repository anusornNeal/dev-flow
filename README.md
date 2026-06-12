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
2. Create a local env file if needed from [`.env.example`](C:\Users\tatar\Projects\dev-flow\.env.example).
3. Start the app with `npm run dev`.

Standard commands:

- `npm run setup` creates the local `data/` directory when needed and bootstraps `.env` from `.env.example` when safe.
- `npm run doctor` checks Node/npm, env file availability, writable SQLite storage, DB initialization, port `3000`, and backed-up project local paths.
- `npm test` runs the lightweight verification flow for this repo (`lint` + `doctor`).
- `npm run dev` starts the DevFlow server in development mode.
- `npm run build` builds the frontend bundle and the Node server output into `dist/`.
- `npm run start` runs the built server from `dist/server.cjs`.
- `npm run lint` runs the TypeScript no-emit verification used in this repo.
- `npm run mcp` starts the DevFlow MCP server entrypoint.

## Windows Start Flow

This repo keeps its Windows-first startup flow:

- `start-all.bat`
- `run-project.bat`
- `run-server.vbs`
- `Start DevFlow.lnk`

Use these when you want the existing one-click local startup behavior instead of manual npm commands.

## Persistence Notes

- SQLite is the active source of truth for tasks, projects, skills, and settings.
- Do not treat `tasks.json` or `projects.json` as active runtime storage.
- Existing `.bak` files are backups created during migration/recovery flows.
- No external database server is required.

## Skills

- Project skill markdown lives under [`skills/`](C:\Users\tatar\Projects\dev-flow\skills).
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
