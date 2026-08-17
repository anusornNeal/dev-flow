# DevFlow

DevFlow is a local-first development task board and AI-agent orchestration app. It keeps projects, tasks, repository context, agent runs, verification, and local Git operations together, and exposes a controlled MCP server that ChatGPT and other agents can use.

DevFlow treats Windows and macOS as first-class local runtime targets.

## First-time Setup

The recommended path on Windows and macOS is intentionally short: install the normal development prerequisites, start DevFlow once, paste your zrok account token when prompted, then use the stable MCP URL shown by DevFlow.

### 1. Install the prerequisites

Install:

- Node.js
- npm
- Git

Clone DevFlow and install dependencies:

```bash
git clone https://github.com/anusornNeal/dev-flow.git
cd dev-flow
npm install
npm run setup
```

`npm run setup` creates the local data/uploads/backups folders, initializes SQLite, and copies `.env.example` to `.env` when `.env` does not already exist.

### 2. Start DevFlow

Recommended one-click startup on Windows:

- Double-click `Start DevFlow.bat`.

Terminal startup on Windows or macOS:

```bash
npm run start:all
```

On Windows, DevFlow keeps the existing persistent `zrokAgent` Windows service bootstrap and may request Administrator approval when the service is installed for the first time.

On macOS, `start:all` uses the native TypeScript bootstrap: it reuses `zrok2` from `DEVFLOW_ZROK_BIN`/PATH when available or downloads the matching darwin binary into `.devflow/bin/zrok2`, then runs the zrok Agent as a user-scoped process. No PowerShell, NSSM, or sudo installation is required for the DevFlow-managed macOS path.

If the zrok environment has not been enabled yet, either platform prompts for:

```text
zrok account token
```

Paste the zrok account token from your zrok account. The prompt does not echo the token; DevFlow uses it to enable the zrok environment and does not write the account token to `.env`.

After the zrok environment is ready, the bootstrap resolves which reserved name this machine should manage. If `DEVFLOW_ZROK_RESERVED_NAME` is configured, that explicit name is used non-interactively. Otherwise DevFlow reuses a valid name saved on this machine. On Windows, first-time setup can prompt you to choose an existing reserved name or **Create new**. On macOS, the non-shell bootstrap reuses the first existing public reserved name when no selection exists, or creates a hostname-based `devflow-...` reserved name when the account has none. The selected name is saved locally in ignored `.devflow/zrok-selection.json` so later launches do not ask again.

That local selection file contains only the reserved name. It does not contain the zrok account token or a public endpoint. The bootstrap then creates the selected name only when needed, enrolls the agent for remote control, and starts the platform-specific zrok Agent lifecycle: Windows service on Windows or a user-scoped Agent process on macOS.

DevFlow does not bake a reserved name or public URL into the repository. For unattended/non-interactive setup you can still override the saved selection explicitly:

```env
DEVFLOW_ZROK_RESERVED_NAME="your-reserved-name"
```

After bootstrap, use the public base URL reported by the live zrok status panel/API. Do not enter or derive an endpoint by concatenating the reserved name with a provider domain.

DevFlow runs locally at:

```text
http://localhost:3000
```

For local-only development without public zrok setup/reconciliation:

```bash
npm run dev
```

### 3. Confirm zrok status

The header shows the live zrok state from DevFlow's backend: `Setup required`, `Starting`, `Online`, `Degraded`, `Offline`, `Standby`, or `Setup error`.

Open the zrok status panel to see agent-service state, reserved-share state, public reachability, latency, and the current MCP URL. The UI does not infer health from a configured string; `Online` requires live backend/public-probe evidence.

If the same reserved name is active on another enrolled machine, this machine reports `Standby`. DevFlow never steals ownership automatically. Use **Take over** only when you intentionally want this machine to become active; DevFlow fences the previous owner first and verifies the public route after takeover.

### 4. Add optional integration credentials

Open **DevFlow → Settings → Integrations** and fill in only the integrations you use:

- **GitHub Access Token** — required only for GitHub-backed context/tools.
- **Jira Base URL** — for example `https://your-domain.atlassian.net`.
- **Jira Email** — the email used by your Jira account.
- **Jira Access Token** — required only when using Jira-backed context/tools.
- **Figma Access Token** — required only when using Figma design context.

You do not need these credentials just to run the DevFlow board or its own MCP tools.

Secrets entered through Settings are stored through DevFlow's credential-vault abstraction. Windows uses current-user DPAPI-backed encrypted storage; macOS uses the current user's Keychain through `/usr/bin/security`. If secure storage is unavailable, credential writes fail closed. Environment variables remain available as runtime overrides/fallbacks.

### 5. Connect DevFlow MCP to ChatGPT

Use the MCP URL shown in the zrok status panel. The repository does not contain a baked public endpoint. A configured endpoint will have the `/mcp` path, for example:

```text
https://your-zrok-public-host.example/mcp
```

Use `/mcp` for new ChatGPT connections. `/sse` is a legacy compatibility transport and should not be used for a new setup.

In ChatGPT, where custom MCP apps/connectors are available for your plan/workspace:

1. Enable Developer mode for custom MCP apps if required by your workspace.
2. Open the app/connector creation flow.
3. Create a custom app for DevFlow.
4. Set the MCP endpoint to the `/mcp` URL shown by DevFlow.
5. Use no MCP authentication for the current personal/local DevFlow transport unless you intentionally placed another authenticated gateway in front of it.
6. Scan tools and confirm that ChatGPT discovers DevFlow tools.
7. Enable the app.

OpenAI can change the exact ChatGPT menu names and plan/workspace availability over time. The stable DevFlow-side requirement is a reachable public HTTPS endpoint ending in `/mcp`.

### 6. Verify the connection

Open the status panel and confirm the zrok state is `Online`, then verify the public capabilities endpoint using the live base URL, for example:

```text
https://your-zrok-public-host.example/api/capabilities
```

Finally, ask ChatGPT to perform a read-only action such as listing DevFlow projects or checking DevFlow health.

If ChatGPT can scan the tools and call a read-only DevFlow tool successfully, first-time setup is complete.

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

Starts the restart-capable DevFlow supervisor and local API at `http://localhost:3000` without reconciling the public zrok service/share.

### DevFlow + zrok + browser

```bash
npm run start:all
```

`start:all` runs setup, starts/reuses the DevFlow API runtime, reconciles the zrok Agent/reserved share, verifies public reachability, and opens the browser. On Windows the Agent is a persistent service; on macOS it is a detached user-scoped Agent process started/reused by `start:all`. In both cases the zrok lifecycle stays outside a guarded DevFlow API-only restart.

See `docs/runtime-supervisor.md` for restart, public-health, zrok reconciliation, and diagnostic behavior.

## Settings and Environment Variables

Most user-facing configuration is in DevFlow Settings. zrok lifecycle configuration is launcher/runtime configuration rather than a manually edited URL in Settings.

Common values:

```env
DEVFLOW_PORT=3000
DEVFLOW_ZROK_RESERVED_NAME="your-reserved-name"
# Optional fallback only; live /api/zrok/status remains authoritative.
DEVFLOW_ZROK_PUBLIC_URL="https://your-zrok-public-host.example"
DEVFLOW_OPEN_BROWSER=true
DEVFLOW_OPEN_BROWSER_DELAY_MS=4000

GITHUB_PERSONAL_ACCESS_TOKEN=""
JIRA_BASE_URL=""
JIRA_EMAIL=""
JIRA_API_TOKEN=""

DEVFLOW_AGENT_TRIGGER_SCRIPT="scripts/trigger-agent.bat" # optional Windows override; macOS uses the native runner path
DEVFLOW_AGENT_EXECUTION_MODE="safe"
DEVFLOW_MCP_TOOL_PROFILE="coding"
```

Notes:

- `DEVFLOW_ZROK_RESERVED_NAME` selects the managed reserved name. Keep it stable if you want the ChatGPT MCP URL to remain stable.
- `DEVFLOW_ZROK_PUBLIC_URL` may pin the expected public base URL; the runtime/status backend remains the source of truth for actual reachability.
- Do not store the zrok account token in `.env`; first-run bootstrap requests it interactively when needed.
- GitHub/Jira/Figma credentials are optional unless you use those integrations.
- Agent CLI authentication is separate from DevFlow integration tokens. Install and authenticate Codex, Antigravity, Claude, or another CLI before asking DevFlow to launch it.
- MCP sessions default to the lean `coding` tool profile when `DEVFLOW_MCP_TOOL_PROFILE` is unset. Available explicit profiles include `full`, `authoring`, `review`, `atlas`, and `diagnostics`.

### Trusted remote API boundary

The public zrok route also exposes DevFlow's HTTP surface. Local loopback requests keep the normal one-click workflow. For `/api` requests coming through a forwarded or non-loopback client, privileged mutation methods are denied by default unless trusted remote mutation access is explicitly configured.

To opt in to trusted remote `/api` mutations:

```env
DEVFLOW_TRUSTED_REMOTE_TOKEN="choose-a-secret"
```

Send the same value as `Authorization: Bearer <token>` or `X-DevFlow-Remote-Token`.

This `/api` policy is separate from the MCP transport policy.

## Runtime and Restart Model

`restart_devflow` is intentionally API-only. An accepted guarded restart replaces the DevFlow API process after returning the MCP response, while the platform zrok Agent and reserved share remain outside the restart scope. The public MCP URL is therefore expected to stay the same across a normal DevFlow restart.

Meaningful queued/active MCP work still blocks restart with `RESTART_BUSY`. After reconnect, `get_devflow_restart_status` can read the same durable restart ticket.

Stopping the DevFlow supervisor stops the supervised DevFlow server, but does not intentionally tear down the zrok Agent/share. Windows keeps the service-managed Agent; macOS reuses a still-running user Agent or starts it again on the next `npm run start:all` (including after a reboot/login cycle).

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | Create local folders, initialize storage, and bootstrap `.env` when safe. |
| `npm run dev` | Start the restart-capable local DevFlow server without zrok reconciliation. |
| `npm run start:all` | Start/reuse DevFlow, reconcile zrok, and open the browser. |
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

1. Open Settings on the old machine and export a backup.
2. Copy the backup to the new machine.
3. Clone the repo and run `npm install` + `npm run setup`.
4. Restore the backup through Settings or `npm run restore <path>`.
5. Re-enter machine-local integration credentials if needed.
6. Run `Start DevFlow.bat`/`npm run start:all` on the new machine. Enter the zrok account token only if that machine still needs environment enablement.
7. When prompted for the zrok reserved name, choose the existing reserved name used by the old machine. Choose **Create new** only when you intentionally want a separate public identity.
8. If that existing reserved name is still active on the old machine, the new machine should show `Standby`; use the explicit **Take over** action only when you intentionally move ownership.
9. DevFlow discovers the actual public endpoint from live zrok state. If you deliberately choose a different reserved name, use the newly reported MCP URL when updating the ChatGPT MCP app.

## Troubleshooting zrok

- **Setup required** — run `Start DevFlow.bat` or `npm run start:all`; approve elevation and enter the zrok account token if prompted.
- **Starting** — the service/share or public probe is still converging. The startup grace window prevents an immediate false recovery loop.
- **Degraded/Offline with local DevFlow healthy** — use **Recheck** first. The supervisor can reconcile the zrok service/share without restarting the local API.
- **Standby** — another enrolled machine owns the reserved name. Use **Take over** only when intentional.
- **Setup error** — inspect the status-panel message and zrok Agent Service state; rerunning `start:all` is idempotent and repairs missing/stopped bootstrap components where safe.
- **DevFlow restart blocked** — `RESTART_BUSY` means meaningful MCP work is still active/recent. Do not force-kill it; retry after work becomes quiescent.

## Tech Stack

- TypeScript
- React + Vite
- Express / Node.js
- SQLite via `better-sqlite3`
- Model Context Protocol (MCP)
- zrok persistent Agent Service + reserved public share
- Local managed Git workspaces and verification tooling
