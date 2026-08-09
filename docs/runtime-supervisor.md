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

### ngrok self-healing in `start:all`

When the ngrok child exits unexpectedly or fails to spawn, the supervisor keeps the DevFlow API child running and retries **ngrok only**. Retry delay uses bounded exponential backoff: 1s, 2s, 4s, and so on up to 30s by default. If one ngrok child stays alive for 60s, the retry attempt counter resets so a later failure starts again at the base delay. The supervisor maintains at most one pending retry timer per managed child.

Intentional `SIGINT`/`SIGTERM` shutdown sets the supervisor shutdown state first, cancels pending retry/stability timers, and then stops children; intentional shutdown therefore never starts an ngrok retry loop.

The defaults can be tuned without changing MCP authentication or transport behavior:

```env
DEVFLOW_NGROK_RESTART_BASE_MS=1000
DEVFLOW_NGROK_RESTART_MAX_MS=30000
DEVFLOW_NGROK_STABLE_RESET_MS=60000
```

Runtime child state is persisted under `.devflow/supervisor-state.json`. `getDevFlowDiagnostics()` reads that state and reports API and tunnel lifecycle independently, including summaries such as `both-healthy`, `api-healthy-tunnel-restarting`, `api-healthy-tunnel-down`, and `api-down-tunnel-healthy`. These are child-process lifecycle diagnostics; `tunnel=healthy` means the ngrok child is running, not that an external Internet reachability probe succeeded.

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
