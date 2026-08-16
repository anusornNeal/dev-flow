# DevFlow Runtime Supervisor

DevFlow has two supported supervised launch modes. Both share the same guarded API restart contract; the difference is whether the launcher also reconciles the persistent zrok public transport.

## Standard startup

Local development:

```bash
npm run dev
```

`npm run dev` starts `scripts/start-all.ts --server-only`. The supervisor launches the raw API through `npm run dev:server` and injects a fresh restart supervisor token. The raw server command remains separate so the supervisor never recursively launches itself.

Full one-click startup:

```bash
npm run start:all
```

`start:all` runs setup, starts/reuses the DevFlow API runtime, reconciles zrok, and opens the browser.

On Windows, `Start DevFlow.bat` launches the hidden tray bootstrap, which requests the same `start:all` path.

## Single-instance runtime ownership

Both launch modes enter the same authoritative single-instance supervisor path. The first launcher atomically claims `.devflow/runtime-owner/` and publishes `owner.json` with an opaque runtime instance id plus a loopback-only control endpoint/token. A later launcher challenges that control endpoint and requires the supervisor name, instance id, PID, and lifecycle state to match before reusing the runtime.

A dead or invalid control identity is treated as stale ownership. Recovery removes only stale ownership metadata and races again for the atomic claim; it never kills a process merely because a PID, process name, or port looks familiar. If the configured DevFlow port is occupied after a new owner is established, startup fails with `DEVFLOW_PORT_CONFLICT` and leaves the unrelated process untouched.

Repeated healthy launches focus/open the recorded DevFlow app URL and do not create a duplicate supervisor/API tree.

## zrok lifecycle

zrok is deliberately not a child tunnel process. On Windows, the one-click bootstrap installs or repairs a persistent `zrokAgent` service and a reserved public name/share.

The first run may require:

1. Administrator approval to install/configure the Windows service.
2. A zrok account token if the service environment has not been enabled yet.
3. Creation of the configured reserved name if the account does not already own it.
4. Agent remoting enrollment so a second enrolled machine can report `Standby` and perform explicit takeover.

The token is requested with a secure prompt and used only for zrok environment enablement; it is not stored in `.env` by the bootstrap.

The default reserved name is `devflow-mixed`, producing the stable public base URL `https://devflow-mixed.shares.zrok.io`. Set `DEVFLOW_ZROK_RESERVED_NAME` before first bootstrap when another reserved name is required.

### Service/share reconciliation

`start:all` invokes `scripts/zrok-bootstrap.ps1` as an idempotent reconciliation step. A successful bootstrap means the required zrok tooling/environment, reserved name, agent enrollment, and Windows service are ready. The supervisor models this logical transport lifecycle as `processes.zrok`, but no zrok child PID is owned by the supervisor.

After service/share readiness, the supervisor probes the public `/api/capabilities` endpoint independently. A fresh generation starts as `unknown`; successful public reachability makes it `healthy`. After startup grace, consecutive failures become `degraded` and then `down` at the configured threshold.

If the public route is `down`, DevFlow probes the local API before recovery. When local `/api/capabilities` is healthy, DevFlow reconciles the zrok service/share only. When the local API is unhealthy, transport-only recovery is suppressed so an API failure is not misclassified as a zrok failure.

A supervisor shutdown stops its DevFlow API child but intentionally leaves the persistent zrok Agent Service/reserved share running. Starting DevFlow again reconciles and reuses that state.

### zrok status and takeover

`GET /api/zrok/status` is the bounded source of truth used by the UI and smoke tooling. It reports one of:

- `setup-required`
- `starting`
- `online`
- `degraded`
- `offline`
- `standby`
- `setup-error`

The status packet includes bounded service/share/public-health evidence and the managed MCP URL; it does not expose account tokens or enrollment secrets.

If another enrolled machine is actively serving the same reserved name, this machine reports `standby`. DevFlow never automatically steals ownership. `POST /api/zrok/takeover` is an explicit operation: it verifies the remote owner, fences the previous owner where supported, activates the local share, and verifies public routing before reporting success.

## Public probe configuration

Defaults can be tuned without changing the MCP endpoint contract:

```env
DEVFLOW_ZROK_RESERVED_NAME="devflow-mixed"
DEVFLOW_ZROK_PUBLIC_URL="https://devflow-mixed.shares.zrok.io"
DEVFLOW_ZROK_PROBE_INTERVAL_MS=15000
DEVFLOW_ZROK_PROBE_TIMEOUT_MS=5000
DEVFLOW_ZROK_PROBE_STARTUP_GRACE_MS=30000
DEVFLOW_ZROK_PROBE_FAILURE_THRESHOLD=3
DEVFLOW_ZROK_RECOVERY_COOLDOWN_MS=15000
```

Runtime supervisor state is persisted under `.devflow/supervisor-state.json`. `getDevFlowDiagnostics()` reads that bounded state directly. It reports API lifecycle and zrok/public-route health separately, including public probe status, latency, generation, consecutive failures, error classification, and recovery attempt metadata when present. It no longer depends on a provider-specific local inspector or a separate tunnel-pressure log.

## Windows launcher and tray

The tray uses a project-scoped Windows mutex so duplicate tray launches reuse the existing control surface. It may request `npm run start:all`, but it does not own the resulting processes; the single-instance supervisor remains authoritative.

Tray **Restart DevFlow** calls the same `/api/restart` guarded-ticket path as `restart_devflow`. Active/queued meaningful MCP work still produces `RESTART_BUSY` rather than a force kill.

Tray **Stop Server && Exit** sends an authenticated loopback shutdown request to the runtime-owner control endpoint. The tray does not sweep ports, kill by process name, directly spawn the raw server, or stop/recreate the zrok Agent Service.

## Raw/debug startup

```bash
npm run dev:server
```

`dev:server` runs `tsx server.ts` directly. It is intended for tests/debugging and is intentionally not self-restartable. A server cannot safely terminate itself and promise relaunch unless a durable parent process owns the handoff.

## Guarded restart lifecycle

`restart_devflow` is API-only and preserves external transport state.

1. The request verifies the supported supervisor identity and matching opaque token.
2. Restart is rejected with `RESTART_BUSY` while durable MCP jobs are queued/active or meaningful Streamable HTTP MCP operations are in-flight/recent inside the bounded quiescence window. The restart request itself and an idle long-lived MCP stream do not keep the runtime permanently busy.
3. DevFlow persists an accepted restart ticket with `runtimeScope=devflow-api-only` and `externalTransportPolicy=preserve-service-and-endpoint`.
4. DevFlow returns the MCP response before exiting with the dedicated restart exit code.
5. The supervisor validates the ticket/token pair and launches a replacement raw API process.
6. The replacement runtime marks the same ticket healthy after startup. Duplicate fresh restart requests reuse the current ticket.

The zrok Agent Service and reserved share are outside this restart path. A normal DevFlow API restart therefore does not stop/re-enroll zrok or intentionally change the public MCP URL.

After reconnect, `get_devflow_restart_status` can read the durable ticket. Missing/spoofed supervisor state remains `RESTART_UNSUPPORTED`; callers should relaunch through a supported supervisor instead of weakening the gate.

The internal supervisor identifier remains `start-all` for backward compatibility with durable restart tickets and tests. The identifier names the supervisor implementation; it does not imply that every supported launch must invoke the `start:all` npm script.

## Process graph

Local development:

```text
npm run dev
  -> DevFlow supervisor (--server-only)
       -> npm run dev:server
            -> server.ts
```

Full Windows startup:

```text
Start DevFlow.bat / npm run start:all
  -> DevFlow supervisor
       -> npm run dev:server
            -> server.ts

persistent external transport
  -> Windows Service: zrokAgent
       -> reserved zrok share
            -> https://<reserved-name>.shares.zrok.io/mcp
```

The API runtime and zrok transport can therefore be restarted/reconciled independently.

## MCP regression smoke

`scripts/smoke-multi-mcp.mjs` keeps two bounded modes:

- **local** — starts an isolated raw DevFlow API, exercises five MCP sessions, raw stream interruption/session retention, restart busy/quiescence behavior, and the production tunnel-health state machine.
- **public** — discovers the managed public base URL from the local `/api/zrok/status` contract and runs five clients against the reserved zrok `/mcp` endpoint. It verifies API/runtime contract stability and that the managed public URL/service generation does not unexpectedly change during the bounded run.

The public smoke does not use a local provider inspector, does not read provider request history/bodies, and does not invent a numeric provider-rate safety margin.

Public `restart_devflow` verification is kept separate from a `run_project_command` smoke invocation because the command itself is a durable active MCP job and correctly causes the guarded restart gate to return `RESTART_BUSY`. Perform the explicit public restart check from an otherwise quiescent MCP client, then verify `/api/zrok/status` reports the same MCP URL after reconnect.

## Startup benchmark

A local Windows benchmark on August 8, 2026 measured three cold-ish launches until the DevFlow TCP port accepted connections:

- Raw `npm run dev:server`: 5298 / 5540 / 5188 ms; average **5342 ms**.
- Supervised `npm run dev`: 5653 / 5812 / 5803 ms; average **5756 ms**.
- Measured supervisor startup overhead: **414 ms (+7.7%)** on that machine.

This is a machine-local historical measurement, not an SLO. The supervisor is a parent process only; once the API is running, normal HTTP/MCP requests go directly to the server and do not traverse another supervisor request hop.
