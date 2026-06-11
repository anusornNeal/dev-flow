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
