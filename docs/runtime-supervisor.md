# DevFlow Runtime Supervisor

DevFlow's standard development command is restart-capable by default.

## Standard startup

```bash
npm run dev
```

`npm run dev` starts `scripts/start-all.ts --server-only`. The supervisor then launches the raw server through `npm run dev:server` and injects a fresh restart supervisor token. The raw server command is deliberately separate so the supervisor never recursively launches itself.

Use the all-services launcher when ngrok and browser startup are wanted:

```bash
npm run start:all
```

`start:all` keeps the existing setup + DevFlow server + ngrok behavior. Both standard launch modes use the same restart handoff and token validation.

## Single-instance runtime ownership

Both `npm run dev` and `npm run start:all` now enter the same authoritative single-instance supervisor path. The first launcher atomically claims `.devflow/runtime-owner/` and publishes `owner.json` with an opaque runtime instance id plus a loopback-only control endpoint/token. A later launcher does not trust the recorded PID by itself: it challenges the control endpoint and requires the supervisor name, opaque instance id, PID, and lifecycle state to match before reusing the runtime.

A dead or invalid control identity is treated as stale ownership. Recovery quarantines/removes only the stale ownership directory and races again for the atomic claim; it never kills a process by PID, process name, or listening port. If the configured DevFlow port is already occupied after a new owner is established, startup fails with `DEVFLOW_PORT_CONFLICT` and leaves the unrelated process untouched.

Repeated healthy launches open/focus the recorded DevFlow app URL and exit without spawning another supervisor/server/ngrok tree.

### Windows launcher and tray

`Start DevFlow.bat` launches the hidden tray bootstrap. The tray uses a project-scoped Windows mutex so duplicate tray launches reuse the existing control surface instead of creating another hidden icon. The tray may request `npm run start:all`, but it never owns the resulting processes; the single-instance supervisor decides whether to start a new runtime or reuse the existing one.

Tray **Restart DevFlow** calls the same `/api/restart` guarded ticket path as `restart_devflow`, so queued/active MCP work still produces `RESTART_BUSY` instead of a force kill. Tray **Stop Server && Exit** sends an authenticated loopback shutdown request to the owner control endpoint and exits only after that request is accepted. The tray contains no port sweep, `taskkill`, kill-by-process-name, direct server spawn, or direct ngrok spawn path.

### ngrok self-healing in `start:all`

When the ngrok child exits unexpectedly or fails to spawn, the supervisor keeps the DevFlow API child running and retries **ngrok only**. Retry delay uses bounded exponential backoff: 1s, 2s, 4s, and so on up to 30s by default. If one ngrok child stays alive for 60s, the retry attempt counter resets so a later failure starts again at the base delay. The supervisor maintains at most one pending retry timer per managed child.

`start:all` also probes public reachability independently from the ngrok PID. The default probe cadence is 15 seconds with a 5-second timeout. A newly running ngrok process starts with tunnel reachability `unknown`; only a successful public `/api/capabilities` probe makes it `healthy`. One or two consecutive failures are `degraded`. Three consecutive failures make it `down`. A single transient failure never restarts ngrok.

When the public tunnel is `down`, the supervisor probes the local DevFlow `/api/capabilities` endpoint before any recovery. If the local API is healthy, the supervisor stops and restarts **ngrok only**. If the local API is also unhealthy, tunnel-only recovery is suppressed so a server problem is not misclassified as an ngrok problem. Tunnel degradation never requests a DevFlow server restart.

ngrok stdout/stderr and supervisor recovery decisions are retained as bounded timestamped JSONL in `.devflow/ngrok-diagnostics.jsonl` (128 KiB by default). URLs and token-like values are redacted before persistence. `ERR_NGROK_334` is classified as an endpoint/session collision and activates a bounded collision backoff before another ngrok launch, preventing a hot restart loop while preserving the single-instance supervisor ownership model.

Intentional `SIGINT`/`SIGTERM` shutdown sets the supervisor shutdown state first, cancels pending retry, stability, and public-probe timers, and then stops children; intentional shutdown therefore never starts an ngrok retry or tunnel-recovery loop.

The defaults can be tuned without changing MCP transport behavior:

```env
DEVFLOW_NGROK_RESTART_BASE_MS=1000
DEVFLOW_NGROK_RESTART_MAX_MS=30000
DEVFLOW_NGROK_STABLE_RESET_MS=60000
DEVFLOW_NGROK_PROBE_INTERVAL_MS=15000
DEVFLOW_NGROK_PROBE_TIMEOUT_MS=5000
DEVFLOW_NGROK_PROBE_FAILURE_THRESHOLD=3
DEVFLOW_NGROK_COLLISION_BACKOFF_MS=30000
DEVFLOW_NGROK_LOG_MAX_BYTES=131072
```

Runtime state is persisted under `.devflow/supervisor-state.json`. `getDevFlowDiagnostics()` reports ngrok process lifecycle and public tunnel reachability separately, including combinations such as process-running + tunnel-unknown/degraded/down. Probe evidence includes the last probe time/status/latency, last success, consecutive failures, and recent classified ngrok error/recovery metadata when available.

The outage investigated on August 13, 2026 remains **root-cause unconfirmed**. `ERR_NGROK_334` is a reproducible collision failure mode, but it must not be treated as proof that it caused that historical outage. Future incidents can be attributed only from the persisted probe/log/recovery timeline or other concrete evidence.

## Raw/debug startup

```bash
npm run dev:server
```

`dev:server` runs `tsx server.ts` directly. It is intended for tests and debugging only and is intentionally **not** self-restartable. A server cannot safely terminate itself and promise to return unless a durable parent process owns relaunch.

## Restart lifecycle

1. `restart_devflow` verifies that the process was launched by the DevFlow supervisor and has the matching opaque supervisor token.
2. Restart is rejected with `RESTART_BUSY` while MCP jobs are queued or active.
3. DevFlow persists an accepted restart ticket and returns the MCP response before exiting with the dedicated restart exit code.
4. The supervisor validates the ticket/token pair and launches a replacement raw server process.
5. The replacement runtime marks the ticket healthy after startup. Duplicate restart requests reuse the current fresh ticket rather than scheduling multiple exits.

Missing or spoofed supervisor state continues to return `RESTART_UNSUPPORTED`; callers should relaunch with `npm run dev` rather than weakening the safety gate.

## Process graph

Standard development:

```text
npm run dev
  -> DevFlow supervisor (--server-only)
       -> npm run dev:server
            -> server.ts
```

All services:

```text
npm run start:all
  -> DevFlow supervisor
       -> npm run dev:server
            -> server.ts
       -> ngrok
```

The supervisor identifier remains `start-all` internally for backward compatibility with existing restart tickets and tests; it now represents the shared supervisor implementation, not a requirement that users invoke the `start:all` npm command.
## Startup benchmark

A local Windows benchmark on August 8, 2026 measured three cold-ish launches of each path until the DevFlow TCP port accepted connections:

- Raw `npm run dev:server`: 5298 / 5540 / 5188 ms; average **5342 ms**.
- Supervised `npm run dev`: 5653 / 5812 / 5803 ms; average **5756 ms**.
- Measured supervisor startup overhead: **414 ms (+7.7%)** on this machine.

This is a machine-local startup measurement, not an SLO. The supervisor is a parent process only; once the server is running, normal HTTP/MCP requests still go directly to the server and do not traverse an additional supervisor request hop.

For the ngrok self-healing change, the existing `verify-start-all` harness remained sub-second in DevFlow's command runner (about 0.43s total in the final focused run, with 6–9ms runner process-startup time observed across RED/GREEN runs). The repository does not currently contain a separate TCP-to-ready startup benchmark script, so the historical cold-start numbers above remain the comparable machine-local reference rather than being replaced by a different measurement method.
