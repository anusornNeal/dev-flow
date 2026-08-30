# DevFlow runtime supervisor

DevFlow has two supported supervisor modes. Both use the same single-instance runtime ownership and guarded API restart contract; only `all` mode manages OpenAI Tunnel.

## Launch modes

### Local only

```bash
npm run dev
```

Starts the DevFlow API/server under `scripts/start-all.ts --server-only`. Tunnel configuration is not required.

### DevFlow + OpenAI Tunnel

```bash
npm run start:all
```

`start:all` runs setup, starts or reuses the local API, waits for `/api/capabilities`, then connects the configured OpenAI Tunnel runtime to the local `/mcp` endpoint.

The platform launchers use the same supervisor:

- Windows `Start DevFlow.bat` -> tray/bootstrap -> `npm run start:all`
- macOS `Start DevFlow.command` -> `npm run start:all`

## OpenAI Tunnel lifecycle

DevFlow delegates tunnel process/profile ownership to the native `tunnel-client runtimes ...` command family instead of reimplementing the tunnel protocol or running an OS-specific service.

The lifecycle wrapper is `scripts/openai-tunnel.ts`.

Supported operator commands:

```bash
npm run tunnel:start
npm run tunnel:status
npm run tunnel:stop
```

The managed alias defaults to `devflow`.

### Start

For an existing remote tunnel, DevFlow uses the equivalent of:

```text
tunnel-client runtimes connect
  --alias <alias>
  --tunnel-id <tunnel_id>
  --runtime-api-key env:<runtime-key-env-name>
  --mcp-server-url http://127.0.0.1:<port>/mcp
  --json
```

Before connecting, DevFlow checks local runtime status so repeated startup can reuse a running alias. After connect, status is read again before the supervisor reports success.

DevFlow never puts the literal runtime key in the command line. Environment-provided keys remain in the process environment; a UI-saved key is loaded from the secure credential vault and injected only into the tunnel-client child environment. Tunnel-client always receives only the `env:<name>` reference.

### Status

`tunnel:status` reads the local managed runtime with `tunnel-client runtimes status <alias> --json`.

DevFlow understands the structured `process_running`, `healthy`, and `ready` fields when available. If the tunnel client succeeds but does not expose a definitive health boolean, supervisor health remains `unknown`; it is not promoted to healthy by assumption.

### Stop

`tunnel:stop` uses `tunnel-client runtimes stop <alias> --json` and confirms stopped status. A missing/already-stopped local runtime is treated idempotently as stopped.

A full supervisor shutdown also stops the managed tunnel before stopping the local DevFlow server.

## Configuration

Tunnel startup requires a Tunnel ID and Runtime API Key. They can be saved from **Settings → Integrations → OpenAI Tunnel**. The Tunnel ID is ordinary local settings data; the Runtime API Key uses the existing secure credential vault and is never returned in plaintext by `/api/settings`.

Environment configuration remains supported as a fallback. Persisted OpenAI Tunnel Settings take precedence when present, so replacing a Tunnel ID or Runtime API Key in the UI is effective without first removing stale machine-level environment variables:

```env
DEVFLOW_OPENAI_TUNNEL_ID="tunnel_your_id"
CONTROL_PLANE_API_KEY="your-runtime-key"
```

Accepted tunnel ID alias:

```env
CONTROL_PLANE_TUNNEL_ID="tunnel_your_id"
```

Saving tunnel settings does not restart a running tunnel. The saved values are resolved on the next tunnel start or reconnect.

Optional:

```env
DEVFLOW_TUNNEL_ALIAS="devflow"
DEVFLOW_TUNNEL_CLIENT_BIN="tunnel-client"
DEVFLOW_TUNNEL_RUNTIME_KEY_ENV="CONTROL_PLANE_API_KEY"
DEVFLOW_TUNNEL_STARTUP_WAIT_MS=30000
TUNNEL_CLIENT_STATE_DIR="..." # otherwise ignored .devflow/tunnel-client
```

The state directory contains machine-local tunnel runtime metadata. It is not portable application data and should not be copied when moving DevFlow to another machine.

## Single-instance ownership

The supervisor owns one runtime record under `.devflow/runtime-owner/owner.json` and exposes a random authenticated loopback control port.

A second launcher probes that owner. When the owner is healthy it reuses the existing local API instead of starting a second server.

If the second launcher requested full `start:all`, it can attach/reuse the tunnel on top of an already-running local-only DevFlow runtime. The supervisor-state tunnel record makes the eventual owner shutdown stop that tunnel too.

Stale owner records are quarantined only after the loopback identity probe proves the prior supervisor is no longer healthy.

## Supervisor diagnostics

Runtime supervisor state is persisted under ignored `.devflow/supervisor-state.json`.

The current state model separates:

- `processes.server` — the DevFlow API child owned by `start-all`.
- `processes.tunnel` — logical tunnel-client managed-runtime lifecycle.
- `tunnelHealth` — bounded health/status evidence returned by tunnel-client.

`getDevFlowDiagnostics()` and `devflow_health_check` project these separately. Provider-specific route probing is not used.

When the local API is healthy but tunnel state is degraded/down, diagnostics recommend `npm run tunnel:status` and tunnel-client diagnostics.

## Unexpected API child recovery

An unexpected DevFlow API child exit or spawn failure is recovered by `start-all` without replacing the supervisor or reconnecting the OpenAI Tunnel runtime. Recovery is intentionally server-only: the tunnel keeps targeting the same local `/mcp` endpoint while the replacement API child starts.

The default bounded policy allows four consecutive recovery attempts with exponential delays of 250 ms, 500 ms, 1 s, and 2 s. Delay is capped at 4 s. A server child that remains alive for 30 seconds resets the consecutive-attempt sequence. Only one recovery timer may be pending, and intentional supervisor shutdown cancels pending recovery.

The guarded `restart_devflow` exit code remains a separate path and never falls through into unexpected-crash recovery. Likewise, a failed replacement for a guarded restart fails that restart ticket rather than starting an unrelated crash loop.

`.devflow/supervisor-state.json` retains bounded `lastUnexpectedServerCrash` evidence across supervisor reinitialization: observation time, previous server PID, runtime-owner instance id when known, exit code/signal, recovery attempt/outcome, and a capped/redacted stderr tail. Common credential-shaped values are removed before persistence. Diagnostics distinguish `unexpected-crash` recovery, `recovered`, and `restart-exhausted` from an intentional guarded restart.

The supervisor does not replay durable MCP jobs after a crash. Existing durable-job recovery remains authoritative: interrupted work is classified from its persisted lease/result state after the API returns.

## Guarded API-only restart

`restart_devflow` remains intentionally scoped to the API child.

Flow:

1. The server validates restart eligibility and creates a durable restart ticket.
2. The MCP response is returned.
3. The API child exits with DevFlow's restart exit code.
4. `start-all` recognizes the ticket/token and launches the replacement server child.
5. The OpenAI Tunnel managed runtime is left running throughout the API restart.
6. The tunnel continues targeting the same local `/mcp` URL, so the replacement API becomes reachable through the existing tunnel runtime once ready.

Meaningful active/recent MCP work blocks restart with `RESTART_BUSY`.

A restart failure updates the durable restart ticket; it does not trigger tunnel teardown.

## Full shutdown

The runtime-owner control endpoint accepts authenticated `POST /shutdown` from the tray. Ctrl+C/SIGTERM uses the same supervisor shutdown path.

Full shutdown order:

1. mark supervisor `shuttingDown`,
2. stop the DevFlow-managed OpenAI Tunnel alias when present,
3. stop the DevFlow API child process tree,
4. release runtime ownership,
5. exit the supervisor.

This is deliberately different from API-only restart.

## Moving to another machine

The portable identity is the OpenAI `tunnel_id`, not tunnel-client's machine-local state directory.

Recommended move:

1. stop the old machine's tunnel,
2. clone/install/setup DevFlow on the new machine,
3. install `tunnel-client`,
4. configure the same tunnel ID and a valid runtime key on the new machine,
5. run `npm run start:all`,
6. confirm `npm run tunnel:status`,
7. make a real read-only MCP call from ChatGPT.

Do not copy `.devflow/tunnel-client` to migrate the runtime.

## Smoke and verification boundary

`scripts/smoke-multi-mcp.mjs` continues to exercise the local Streamable HTTP MCP concurrency/session/restart behavior.

The retired provider-public-URL smoke mode is intentionally gone. OpenAI Tunnel does not require DevFlow to publish a provider public base URL that a local smoke process can call directly. Tunnel-path verification is therefore:

1. `npm run tunnel:status` for native local runtime health,
2. a real MCP call from ChatGPT/OpenAI through the configured tunnel ID.
