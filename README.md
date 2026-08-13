# DevFlow

DevFlow is a local-first development task board and AI-agent orchestration app. It keeps projects, tasks, repository context, agent runs, verification, and local Git operations together, and exposes a controlled MCP server that ChatGPT and other agents can use.

DevFlow is Windows-first and also supports normal local development on macOS.

## First-time Setup

This is the recommended path for a new machine. The goal is to get from a fresh clone to a working DevFlow app that ChatGPT can reach through MCP.

### 1. Install the prerequisites

Install:

- Node.js
- npm
- Git
- ngrok

Clone DevFlow and initialize the local environment:

```bash
git clone https://github.com/anusornNeal/dev-flow.git
cd dev-flow
npm install
npm run setup
```

`npm run setup` creates the local data/uploads/backups folders, initializes SQLite, and copies `.env.example` to `.env` when `.env` does not already exist.

### 2. Create an ngrok account and get your free domain

1. Create an ngrok account.
2. Copy your ngrok **authtoken** from the ngrok dashboard and add it to the ngrok CLI once:

```bash
ngrok config add-authtoken <YOUR_NGROK_AUTHTOKEN>
```

3. Find the free **development domain** assigned to your account, for example:

```text
your-name.ngrok-free.app
```

The free ngrok plan currently provides an automatically assigned development domain. You do not need to buy or reserve a custom domain for the normal DevFlow setup.

### 3. Start DevFlow with ngrok

Recommended one-click startup:

- **Windows:** double-click `Start DevFlow.bat`
- **macOS:** double-click `Start DevFlow.command`
- **Terminal / any OS:** run:

```bash
npm run start:all
```

`start:all` runs setup, starts DevFlow, starts ngrok, and opens the browser. Without an explicit domain override, ngrok uses the development domain assigned to your account.

DevFlow runs locally at:

```text
http://localhost:3000
```

For local-only development without ngrok:

```bash
npm run dev
```

### 4. Put the ngrok URL in DevFlow Settings

Open **DevFlow → Settings** and set **ngrok URL** to the full HTTPS URL:

```text
https://your-name.ngrok-free.app
```

Use the full URL including `https://`.

If you intentionally use a paid/custom ngrok domain, you can also pin the launcher to it in `.env`:

```env
DEVFLOW_NGROK_DOMAIN="your-custom-domain.ngrok.app"
```

For the normal free development domain, this override is usually unnecessary.

### 5. Add integration tokens in Settings

Still in **DevFlow → Settings → Integrations**, fill in the integrations you want DevFlow to use:

- **GitHub Access Token** — required only for GitHub-backed context/tools.
- **Jira Base URL** — for example `https://your-domain.atlassian.net`.
- **Jira Email** — the email used by your Jira account.
- **Jira Access Token** — required only when using Jira-backed context/tools.
- **Figma Access Token** — required only when using Figma design context.

You do not need every token just to run the DevFlow board or its own MCP tools. Add the credentials for the integrations you actually use.

Secrets entered through Settings are stored through DevFlow's credential-vault abstraction. On Windows this uses current-user DPAPI-backed encrypted storage. Environment variables remain available as overrides/fallbacks.

### 6. Connect DevFlow MCP to ChatGPT

DevFlow exposes its current MCP transport at:

```text
https://your-name.ngrok-free.app/mcp
```

Use `/mcp` for new ChatGPT connections. `/sse` remains a legacy compatibility transport and should not be used for a new setup.

In ChatGPT web, where custom MCP apps/connectors are available for your plan/workspace:

1. Enable **Developer mode** for custom MCP apps if it is not already enabled.
2. Open **Settings → Apps → Create** (workspace/admin wording can vary by plan).
3. Create a custom app for DevFlow.
4. Set the MCP endpoint to:

   ```text
   https://your-name.ngrok-free.app/mcp
   ```

5. Use **no authentication** for the current personal/local DevFlow MCP transport unless you have added your own gateway/authentication in front of it.
6. Choose **Scan Tools** and confirm that ChatGPT can discover the DevFlow tools.
7. Create/enable the app.

OpenAI changes Developer mode and custom MCP availability over time, so the exact menu names and plan requirements can change. The stable DevFlow-side requirement is the public HTTPS endpoint ending in `/mcp`.

### 7. Verify the connection

Before testing ChatGPT, confirm that the public DevFlow endpoint is reachable:

```text
https://your-name.ngrok-free.app/api/capabilities
```

Then start a ChatGPT conversation with the DevFlow app enabled and ask it to perform a simple read-only action, such as listing DevFlow projects or checking DevFlow health.

If ChatGPT can scan the tools and call a read-only DevFlow tool successfully, the first-time setup is complete.

## What DevFlow Can Do

- **Project and task board** — manage projects, cards, priorities, statuses, checklists, target files, branches, and review flow.
- **AI agent orchestration** — prepare agent-ready prompts and launch configured agents such as Codex, Antigravity, or Claude from a DevFlow card.
- **Agent run tracking** — store queued/running/succeeded/failed/cancelled run history in SQLite and keep prompt/log artifacts under `.devflow/runs/`.
- **Local repository tools** — inspect Git status/diff, read local files, apply guarded edits, run verification commands, and create local commits without pushing.
- **MCP server** — expose DevFlow tools to ChatGPT/agents through one controlled interface.
- **Connector helpers** — centralize Jira, GitHub, Figma, and other external context when credentials are configured.
- **Skills and prompts** — store reusable authoring/review guidance and prompt templates.
- **Backup and restore** — export, back up, restore, and migrate local DevFlow data without an external database server.

## Startup Modes

### Local only

```bash
npm run dev
```

Starts DevFlow at `http://localhost:3000` without ngrok.

### DevFlow + ngrok + browser

```bash
npm run start:all
```

`start:all` runs setup, starts DevFlow, starts ngrok, and opens the browser. If ngrok exits unexpectedly, the supervisor keeps the DevFlow API running and restarts ngrok with bounded backoff. Public reachability is monitored separately from the ngrok process lifecycle.

See `docs/runtime-supervisor.md` for restart, tunnel-health, collision-recovery, and diagnostic behavior.

## Settings and Environment Variables

Most configuration can be done through **DevFlow → Settings**. Environment variables are useful for launcher/runtime overrides and automation.

Common values:

```env
DEVFLOW_PORT=3000
DEVFLOW_NGROK_DOMAIN=""
DEVFLOW_OPEN_BROWSER=true
DEVFLOW_OPEN_BROWSER_DELAY_MS=4000

GITHUB_PERSONAL_ACCESS_TOKEN=""
JIRA_BASE_URL=""
JIRA_EMAIL=""
JIRA_API_TOKEN=""

DEVFLOW_AGENT_TRIGGER_SCRIPT="scripts/trigger-agent.bat"
DEVFLOW_AGENT_EXECUTION_MODE="safe"
DEVFLOW_MCP_TOOL_PROFILE="coding"
```

Notes:

- `DEVFLOW_NGROK_DOMAIN` is an optional launcher override. The normal free ngrok development-domain flow can leave it empty.
- GitHub/Jira/Figma credentials are optional unless you use those integrations.
- Agent CLI authentication is separate from DevFlow integration tokens. Install and authenticate Codex, Antigravity, Claude, or another CLI before asking DevFlow to launch it.
- MCP sessions default to the lean `coding` tool profile when `DEVFLOW_MCP_TOOL_PROFILE` is unset. Available explicit profiles include `full`, `authoring`, `review`, `atlas`, and `diagnostics`.

### Trusted remote API boundary

The public ngrok URL also exposes DevFlow's HTTP surface. Local loopback requests keep the normal one-click workflow. For `/api` requests coming through a forwarded or non-loopback client, privileged mutation methods are denied by default unless trusted remote mutation access is explicitly configured.

To opt in to trusted remote `/api` mutations:

```env
DEVFLOW_TRUSTED_REMOTE_TOKEN="choose-a-secret"
```

Send the same value as `Authorization: Bearer <token>` or `X-DevFlow-Remote-Token`.

This `/api` policy is separate from the MCP transport policy.

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | Create local folders, initialize storage, and bootstrap `.env` when safe. |
| `npm run dev` | Start the local DevFlow server. |
| `npm run start:all` | Start DevFlow + ngrok + browser. |
| `npm run doctor` | Check Node/npm, env files, SQLite, DB initialization, port availability, and project paths. |
| `npm run typecheck` | Run TypeScript no-emit verification. |
| `npm run lint` | Alias for TypeScript no-emit verification. |
| `npm run verify` | Run the repository verification harness. |
| `npm test` | Alias for `npm run verify`. |
| `npm run build` | Build frontend and server into `dist/`. |
| `npm run start` | Run the built server from `dist/server.js`. |
| `npm run mcp` | Start the DevFlow MCP server entrypoint. |
| `npm run backup` | Create a timestamped local backup. |
| `npm run restore <path>` | Restore from a backup DB or bundle. |
| `npm run migrate:json` | Migrate legacy JSON task/project data into SQLite. |

## Agent Workflow

A typical DevFlow agent run:

1. Create or update a card with clear scope, target files, acceptance criteria, and verification.
2. Assign a supported agent/model/effort.
3. Move the card into an executable status when Auto Work is enabled.
4. DevFlow creates an agent run and its prompt artifact.
5. The configured agent works from the prompt and repository context.
6. DevFlow tracks the run and retains logs/prompts for inspection.

For repository work through MCP, prefer the managed DevFlow workflow:

1. Read compact repository context with `get_repo_context_bundle`.
2. Read exact files before editing.
3. Use guarded edits in a managed workspace.
4. Inspect Git status/diff.
5. Run risk-appropriate final verification.
6. Commit only task-owned changes.
7. Integrate locally according to the project Git policy.
8. Do not push unless explicitly requested.

## Data and Persistence

- SQLite is the runtime source of truth for tasks, projects, skills, settings, and agent runs.
- The default local DB lives under `data/devflow.db`.
- Runtime agent artifacts live under `.devflow/runs/` and are ignored by Git.
- Managed workspaces are local and isolated from the shared base branch while work is in progress.
- No external database server is required.

## Backup, Restore, and Moving to Another Machine

DevFlow Settings can create verified recovery snapshots with checksum/integrity/schema metadata. Secrets are not copied into portable backups.

To move DevFlow to another machine:

1. Open **Settings** on the old machine.
2. Export a backup.
3. Copy the backup to the new machine.
4. Clone the repo and run `npm install` + `npm run setup`.
5. Restore the backup through Settings or `npm run restore <path>`.
6. Re-enter machine-local integration credentials if needed.
7. Configure ngrok on the new machine and run `npm run start:all`.
8. Update the ChatGPT MCP app endpoint if the public domain changed.

## Tech Stack

- TypeScript
- React + Vite
- Express / Node.js
- SQLite via `better-sqlite3`
- Model Context Protocol (MCP)
- Local managed Git workspaces and verification tooling
