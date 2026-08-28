# DevFlow

DevFlow is a local-first development task board and AI-agent orchestration app. It keeps projects, tasks, repository context, agent runs, verification, and local Git operations together, and exposes a controlled MCP server that ChatGPT and other agents can use.

Windows and macOS are first-class local runtime targets.

## First-time setup

### 1. Install prerequisites

Install:

- Node.js
- npm
- Git
- OpenAI `tunnel-client` when you want ChatGPT/OpenAI Tunnel access

`tunnel-client` must either be available on `PATH` or be configured through `DEVFLOW_TUNNEL_CLIENT_BIN` / `TUNNEL_CLIENT_BIN`.

Clone DevFlow and initialize it:

```bash
git clone https://github.com/anusornNeal/dev-flow.git
cd dev-flow
npm install
npm run setup
```

`npm run setup` creates local data/uploads/backups folders, initializes SQLite, and copies `.env.example` to `.env` when `.env` does not already exist.

### 2. Configure OpenAI Tunnel

Create the tunnel in OpenAI once. After DevFlow is running locally, open **Settings → Integrations → OpenAI Tunnel** and save:

- the existing `tunnel_...` Tunnel ID, and
- the Runtime API Key.

The Tunnel ID is stored as normal local DevFlow settings data. The Runtime API Key is stored in the secure credential vault (Windows DPAPI / macOS Keychain) and the browser receives only masked state after saving.

Environment variables remain supported and take precedence over saved UI values:

```env
DEVFLOW_OPENAI_TUNNEL_ID="tunnel_your_id"
CONTROL_PLANE_API_KEY="your-runtime-key"
```

`CONTROL_PLANE_TUNNEL_ID` is also accepted as the tunnel-ID variable.

Optional runtime settings:

```env
DEVFLOW_TUNNEL_ALIAS="devflow"
DEVFLOW_TUNNEL_CLIENT_BIN="tunnel-client"
DEVFLOW_TUNNEL_RUNTIME_KEY_ENV="CONTROL_PLANE_API_KEY"
DEVFLOW_TUNNEL_STARTUP_WAIT_MS=30000
```

DevFlow passes the runtime key to `tunnel-client` by environment reference (`env:<name>`). A saved vault key is injected only into the child process environment for the tunnel command. DevFlow does not put the literal key in tunnel command arguments, SQLite settings, committed configuration, API responses, or supervisor state.

The local tunnel runtime state defaults to ignored `.devflow/tunnel-client`. It is machine-local cache/state and does not need to be copied to another computer.

### 3. Start DevFlow + tunnel

Recommended one-click startup on Windows:

- Double-click `Start DevFlow.bat`.

Terminal startup on Windows or macOS:

```bash
npm run start:all
```

`start:all`:

1. runs DevFlow setup,
2. starts or reuses the local DevFlow API,
3. waits for the local API to become ready,
4. connects the configured OpenAI Tunnel runtime to the local `/mcp` endpoint,
5. opens the DevFlow browser UI.

DevFlow runs locally at:

```text
http://localhost:3000
```

For local-only development without tunnel credentials:

```bash
npm run dev
```

### 4. Check or control the tunnel

```bash
npm run tunnel:status
npm run tunnel:start
npm run tunnel:stop
```

`tunnel:start` is intended for a local DevFlow server that is already running. Normal one-click use should prefer `npm run start:all`.

`tunnel:stop` stops only the DevFlow tunnel runtime. It does not stop the local DevFlow API.

Stopping the `start:all` supervisor (Ctrl+C or tray **Stop Server && Exit**) stops the DevFlow-managed tunnel and then the local server.

### 5. Add optional integration credentials

Open **DevFlow → Settings → Integrations** and configure only the integrations you use:

- **GitHub Access Token** — required only for GitHub-backed context/tools.
- **Jira Base URL** — for example `https://your-domain.atlassian.net`.
- **Jira Email** — the email used by your Jira account.
- **Jira Access Token** — required only when using Jira-backed context/tools.
- **Figma Access Token** — required only when using Figma design context.

You do not need these credentials just to run the DevFlow board or its own MCP tools.

Secrets entered through Settings use DevFlow's credential-vault abstraction. Windows uses current-user DPAPI-backed encrypted storage; macOS uses the current user's Keychain through `/usr/bin/security`. Environment variables remain valid runtime overrides/fallbacks.

### 6. Connect from ChatGPT

Use the same OpenAI Tunnel ID configured for the local runtime when configuring the DevFlow MCP connection in the OpenAI/ChatGPT tunnel flow. DevFlow no longer creates or exposes a provider-specific public hostname.

The local MCP target behind the tunnel is:

```text
http://127.0.0.1:3000/mcp
```

After `npm run start:all`, confirm:

```bash
npm run tunnel:status
```

Then ask ChatGPT to perform a read-only action such as listing DevFlow projects or checking DevFlow health. A successful MCP tool call is the end-to-end tunnel check.

## What DevFlow can do

- **Project and task board** — manage projects, cards, priorities, statuses, checklists, target files, branches, and review flow.
- **AI agent orchestration** — prepare agent-ready prompts and launch configured agents such as Codex, Antigravity, or Claude from a DevFlow card.
- **Agent run tracking** — store queued/running/succeeded/failed/cancelled run history in SQLite and retain run artifacts locally.
- **Local repository tools** — inspect Git status/diff, read local files, apply guarded edits, run verification commands, and create local commits without pushing.
- **MCP server** — expose DevFlow tools through one controlled interface.
- **Connector helpers** — centralize Jira, GitHub, Figma, and other external context when credentials are configured.
- **Skills and prompts** — store reusable authoring/review guidance and prompt templates.
- **Backup and restore** — back up, restore, and migrate local DevFlow data without an external database server.

## Startup modes

### Local only

```bash
npm run dev
```

Starts the restart-capable DevFlow supervisor and local API at `http://localhost:3000`. Tunnel configuration is not required.

### DevFlow + OpenAI Tunnel + browser

```bash
npm run start:all
```

Starts/reuses DevFlow and connects the configured OpenAI Tunnel runtime. The tunnel is lifecycle-managed through `tunnel-client runtimes ...`, not through an OS service manager.

See `docs/runtime-supervisor.md` for startup, shutdown, restart, and diagnostic behavior.

## Settings and environment variables

Common launcher/runtime values:

```env
DEVFLOW_PORT=3000
DEVFLOW_OPENAI_TUNNEL_ID="tunnel_your_id"
CONTROL_PLANE_API_KEY="your-runtime-key"
DEVFLOW_TUNNEL_ALIAS="devflow"
DEVFLOW_TUNNEL_CLIENT_BIN="tunnel-client"
DEVFLOW_TUNNEL_RUNTIME_KEY_ENV="CONTROL_PLANE_API_KEY"
DEVFLOW_TUNNEL_STARTUP_WAIT_MS=30000
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

- Keep the tunnel ID stable when you want the same OpenAI tunnel identity across machines.
- The runtime key is machine-local secret configuration. Do not commit `.env`.
- `DEVFLOW_TUNNEL_RUNTIME_KEY_ENV` changes which environment variable is referenced; it is useful when your runtime key already lives under another secret variable name.
- `TUNNEL_CLIENT_STATE_DIR` can override the machine-local tunnel state directory; DevFlow defaults it to ignored `.devflow/tunnel-client`.
- GitHub/Jira/Figma credentials are optional unless you use those integrations.
- Agent CLI authentication is separate from DevFlow integration tokens.
- MCP sessions default to the lean `coding` tool profile when `DEVFLOW_MCP_TOOL_PROFILE` is unset.

### Trusted remote API boundary

OpenAI Tunnel is connected specifically to DevFlow's local `/mcp` target; DevFlow no longer depends on a provider public base URL for its whole HTTP surface.

The existing API access policy still protects `/api` if you separately expose it through another forwarded/non-loopback path. Privileged remote mutations are denied by default unless trusted remote mutation access is explicitly configured.

## Runtime and restart model

`restart_devflow` is intentionally **API-only**. An accepted guarded restart replaces the DevFlow API child after the MCP response is returned. The OpenAI Tunnel runtime remains running and reconnects to the replacement local API process at the same `/mcp` target.

Meaningful queued/active MCP work still blocks restart with `RESTART_BUSY`. After reconnect, `get_devflow_restart_status` can read the same durable restart ticket.

This differs from full supervisor shutdown:

- `restart_devflow` → restart API only; preserve tunnel.
- `npm run tunnel:stop` → stop tunnel only; preserve API.
- Ctrl+C / tray **Stop Server && Exit** → stop tunnel and API.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | Create local folders, initialize storage, and bootstrap `.env` when safe. |
| `npm run dev` | Start the restart-capable local DevFlow server without tunnel setup. |
| `npm run start:all` | Start/reuse DevFlow, connect OpenAI Tunnel, and open the browser. |
| `npm run tunnel:start` | Connect/reuse the configured local OpenAI Tunnel runtime. |
| `npm run tunnel:status` | Read the managed tunnel runtime status. |
| `npm run tunnel:stop` | Stop only the managed OpenAI Tunnel runtime. |
| `npm run doctor` | Check Node/npm, env files, SQLite, DB initialization, port availability, and project paths. |
| `npm run typecheck` | Run TypeScript no-emit verification. |
| `npm run verify` | Run the repository verification harness. |
| `npm test` | Alias for `npm run verify`. |
| `npm run build` | Build frontend and server into `dist/`. |
| `npm run backup` | Create a timestamped local backup. |
| `npm run restore <path>` | Restore from a backup DB or bundle. |

## Agent workflow

A typical DevFlow agent run:

1. Create/update a card with clear scope, target files, acceptance criteria, and verification.
2. Assign a supported agent/model/effort.
3. Move the card into an executable status when Auto Work is enabled.
4. DevFlow creates an agent run and prompt artifact.
5. The configured agent works from the prompt and repository context.
6. DevFlow tracks the run and retains logs/prompts for inspection.

For repository work through MCP, prefer the managed DevFlow workflow: inspect compact context, read exact files, edit in a managed workspace, inspect Git diff, run final risk-appropriate verification, commit task-owned work, and integrate locally. Do not push unless explicitly requested.

## Data and persistence

- SQLite is the runtime source of truth for tasks, projects, skills, settings, and agent runs.
- The default local DB lives under `data/devflow.db`.
- Runtime agent artifacts and managed workspace metadata live under ignored `.devflow/` paths.
- OpenAI Tunnel local runtime state defaults to `.devflow/tunnel-client` and is also ignored.
- No external database server is required.

## Backup, restore, and moving to another machine

DevFlow backups contain application data, not machine-local secrets.

To move DevFlow to another machine:

1. Export a DevFlow backup on the old machine when you need to move board/application data.
2. Stop the old machine's tunnel with `npm run tunnel:stop` or stop the full DevFlow supervisor.
3. Clone the repo on the new machine.
4. Run `npm install` and `npm run setup`.
5. Install `tunnel-client` and make it available on `PATH`, or set `DEVFLOW_TUNNEL_CLIENT_BIN`.
6. Restore the DevFlow backup if needed.
7. Configure the same `DEVFLOW_OPENAI_TUNNEL_ID` and a valid runtime API key on the new machine.
8. Re-enter other machine-local integration credentials when needed.
9. Run `Start DevFlow.bat` or `npm run start:all`.
10. Run `npm run tunnel:status`, then make one read-only DevFlow MCP call from ChatGPT.

Do **not** copy `.devflow/tunnel-client` between machines. The runtime alias/profile is recreated from the tunnel ID, key reference, and local MCP URL.

## Troubleshooting OpenAI Tunnel

- **`TUNNEL_CONFIG_INVALID`** — configure `DEVFLOW_OPENAI_TUNNEL_ID` and the runtime-key environment variable.
- **`TUNNEL_CLIENT_NOT_FOUND`** — install `tunnel-client`, add it to `PATH`, or set `DEVFLOW_TUNNEL_CLIENT_BIN` to the executable path.
- **Tunnel start skipped because API is not ready** — confirm `http://localhost:3000` works locally, then retry `npm run tunnel:start`.
- **Tunnel command succeeds but health is not definitive** — inspect `npm run tunnel:status`; DevFlow reports `unknown` instead of inventing a healthy state when tunnel-client does not return a definitive health field.
- **Need to disconnect ChatGPT access without stopping DevFlow** — run `npm run tunnel:stop`.
- **DevFlow restart blocked** — `RESTART_BUSY` means meaningful MCP work is active/recent; retry once the runtime is quiescent.

## Tech stack

- TypeScript
- React + Vite
- Express / Node.js
- SQLite via `better-sqlite3`
- Model Context Protocol (MCP)
- OpenAI `tunnel-client` managed runtime
- Local managed Git workspaces and verification tooling
