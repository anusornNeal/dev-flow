# zrok Switch Here Design

> **Historical / superseded:** This design records the retired zrok ownership flow. Current runtime guidance is `docs/runtime-supervisor.md` and uses OpenAI Tunnel. Keep this file only as design history; do not use it as current implementation guidance.

## Goal

Allow a user to move the managed reserved zrok share to the current DevFlow machine with one explicit confirmation when the zrok controller does not support authenticated remote-agent fencing.

## Constraints

- Existing safe `Take over` remains unchanged when remote fencing is available.
- `Switch here` is explicit and destructive; polling and Recheck never mutate ownership.
- The active remote share is deleted only after a fresh managed-name/share/env binding check.
- The current machine starts a local Agent share only after the exact remote share is gone.
- Success requires a final public probe routed to the current runtime.
- No token or share credential is returned, logged, or rendered.
- The UI must warn that the old Agent can reclaim the share unless it is stopped.
- The Windows service Agent remains LocalSystem; bootstrap grants only the interactive account access to its `.zrok2` profile, and local share commands use that same profile.

## Flow

`ZrokStatusPanel` renders `Switch here` when the status is `standby`, the local Agent is healthy enough to act, and takeover is blocked because remote fencing is unavailable/unsupported. The user confirms the destructive action. `POST /api/zrok/switch-here` calls a serialized runtime transition. The runtime re-discovers the exact managed share, calls the existing account-level `deleteShare`, verifies the remote binding disappeared, starts the local share with the existing `startLocalShare`, and verifies public routing. Any failure returns an explicit non-success result and never reports completion.

## Failure behavior

- Missing/ambiguous managed binding: HTTP 409; no mutation.
- Account delete failure or account throttling: HTTP 502/429; local start is not attempted.
- Local share start failure: HTTP 502; status reports partial/unavailable state.
- Final public probe failure: HTTP 502; status reports degraded/unverified state.
- Concurrent takeover/switch requests share one in-flight transition.

## Verification

Add runtime tests for the force path, binding races, failed delete/start/probe, and concurrent transitions; route tests for the new endpoint and status mapping; component tests for visibility, confirmation, busy, and failure states. Run focused suites, typecheck, and diff checks.
