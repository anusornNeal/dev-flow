# Dynamic zrok Agent Runtime Design

> **Historical / superseded:** This design records the retired zrok transport. Current runtime guidance is `docs/runtime-supervisor.md` and uses OpenAI Tunnel. Keep this file only as design history; do not use it as current implementation guidance.

## Goal

Make DevFlow report and probe the zrok share actually managed by the local Windows `zrokAgent` service, derive the MCP endpoint dynamically for any machine and account, and never offer takeover when authenticated remote fencing is unavailable.

## Constraints

- Do not hard-code a reserved name, account, public host, or `shares.zrok.io` domain.
- Do not copy `environment.json`, account tokens, share tokens, or other zrok credentials into the repository or runtime state.
- Preserve the persistent `LocalSystem` Windows service model.
- Fail closed for ownership-changing operations.
- Preserve unrelated dirty-worktree changes.

## Architecture

The local zrok Agent loopback console is the primary authority for local share state. DevFlow discovers the console on a bounded loopback port range (or an explicit loopback-only override), calls `/v1/agent/status` with strict timeout and response-size limits, and selects exactly one active public/proxy share whose canonical backend endpoint matches the configured DevFlow target.

The selected share's live `frontendEndpoint` supplies the public base URL. A bare host is normalized to `https://`; an explicit `http://` or `https://` URL keeps its scheme. DevFlow never constructs a hostname from a reserved name. A live Agent endpoint outranks account metadata and configuration fallbacks, so changing machine, account, name, or provider domain is reflected without source changes.

Interactive-user `~/.zrok2` remains an optional account-discovery fallback for remote-state diagnostics only. It is not used to decide whether a LocalSystem-managed share is local.

## Components and Data Flow

### Local Agent adapter

`zrokRuntimeService` gains a bounded local-Agent status operation returning only sanitized share metadata: mode, backend endpoint, frontend endpoint, and lifecycle status. Tokens may be used internally for an explicit mutation but must never enter public status, logs, or persisted snapshots.

Local ownership is established by the running local Agent reporting the target-matching share. Zero matches means no local share. More than one match is ambiguous and produces a degraded, non-actionable status rather than choosing the first item.

### Dynamic endpoint selection

Endpoint precedence is:

1. Target-matching live local-Agent share endpoint.
2. Live managed-name/share endpoint from compatible account discovery.
3. Explicit configured base URL as a last-resort fallback.

Every candidate passes the same URL normalization and validation. `start-all` consumes the current base URL returned by local `/api/zrok/status` and updates its public probe target when that URL changes.

### Bootstrap and remoting capability

Bootstrap installs/starts the local service independently of optional Agent remoting. A controller response that explicitly reports Agent enrollment as unimplemented is recorded as `remoteControl: unsupported`; it does not misclassify an otherwise healthy local Agent/share as a failed transport.

Bootstrap and runtime must not synthesize `${reservedName}.shares.zrok.io`. Readiness returns the endpoint observed from the live local Agent when available.

Authenticated takeover remains disabled unless the controller proves all required capabilities: remote enrollment, remote status visibility, exact-owner revalidation, and remote unshare. The currently observed HTTP 501 capability cannot safely fence another machine, so DevFlow reports the precise blocked reason and performs no ownership mutation.

### UI contract

The UI models `actionability` as the structured backend object. It shows an enabled **Take over** action only when `canTakeOver` is true. When false, the panel shows `takeoverBlockedReason` and does not invite an impossible action.

## Error Handling

- Reject non-loopback Agent-console configuration.
- Bound console discovery, request time, response size, and JSON shape.
- Treat an unreachable local Agent separately from an unsupported remote-control capability.
- Treat multiple target-matching shares as ambiguous.
- Never turn HTTP 501 into successful remoting; only allow local transport readiness to proceed.
- Never expose account or share tokens in API responses, logs, tests, or runtime files.

## Testing

- Server tests cover local Agent authority across profile IDs, a bare dynamic hostname, a custom-domain URL, zero/one/multiple target matches, endpoint changes, unsupported remoting, and token redaction.
- PowerShell bootstrap tests cover HTTP 501 as nonfatal for local service readiness and assert no constructed public hostname.
- Supervisor tests cover replacing the active public probe URL from `/api/zrok/status` without restart.
- Component tests cover structured actionability, blocked-reason rendering, and omission/disablement of takeover when `canTakeOver` is false.
- Focused verification includes the relevant server/component tests, bootstrap verifier, supervisor verifier, typecheck, and a live read-only `/api/zrok/status` probe.

## Supported Scope

This change fully supports dynamic local status and MCP URL discovery after a machine/account has a configured local Agent share. Authenticated transfer from a genuinely different machine remains unavailable when the provider returns HTTP 501 for Agent remoting; the UI and API will state that limitation honestly rather than attempting an unsafe takeover.
