# zrok Existing-or-New One-Click Setup Implementation Plan

> **Historical / superseded:** This plan targets the retired zrok bootstrap. Current runtime guidance is `docs/runtime-supervisor.md` and uses OpenAI Tunnel. Do not execute this plan against the current codebase.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a DevFlow machine reuse an account-owned zrok reserved name or create a new one during one-click setup, while persisting only the selected name locally and continuing to discover the public endpoint from live zrok state.

**Architecture:** Keep first-run interaction in `scripts/zrok-bootstrap.ps1`, because zrok bootstrap happens before the in-app status UI can be relied on. The bootstrap enables the zrok environment, discovers account-owned names, resolves an explicit/saved/interactive name selection, creates the selected name only when missing, and saves the non-secret selection under ignored `.devflow` state. The runtime reads that saved selection as a fallback after `DEVFLOW_ZROK_RESERVED_NAME`, so accounts with multiple names remain deterministic without storing or asking for an endpoint.

**Tech Stack:** PowerShell, zrok2 CLI v2 (`list names --json`, `create name`), TypeScript/Node.js, Node test runner.

## Global Constraints

- Never persist or print the zrok account token.
- Never ask the user to enter a public endpoint and never synthesize a provider hostname from a reserved name.
- `DEVFLOW_ZROK_RESERVED_NAME` remains the highest-priority non-interactive override.
- Persist only the selected reserved name in ignored local `.devflow` state.
- Repeated startup with a valid saved selection must not prompt again.
- Existing `Standby` / explicit `Take over` behavior remains unchanged.
- Keep Windows one-click bootstrap idempotent.

---

### Task 1: Bootstrap selection behavior

**Files:**
- Modify: `scripts/zrok-bootstrap.ps1`
- Test: `scripts/verify-zrok-bootstrap.ps1`

**Interfaces:**
- Consumes: existing `Invoke-ZrokBootstrap -Ops <hashtable> -ReservedName <string> -EnableRemoting <bool>`.
- Produces: resolved `reservedName` in the bootstrap result; operations `GetSavedReservedName`, `ListOwnedReservedNames`, `ChooseReservedName`, and `SaveReservedName` used by the orchestration.

- [ ] **Step 1: Add failing fake-op scenarios** for explicit override, saved-name reuse, existing-name choice, new-name creation, saved selection, and rerun idempotency.
- [ ] **Step 2: Run `test-zrok-bootstrap` and confirm RED** because selection behavior is not implemented.
- [ ] **Step 3: Implement selection orchestration** in this order: explicit requested name → valid saved owned name → interactive existing/new selection; create only a missing selected name and save it after ownership is established.
- [ ] **Step 4: Implement default local selection IO and prompts** using `.devflow/zrok-selection.json` containing only `{ "reservedName": "..." }`; list account-owned names and offer `Create new`; never ask for or construct an endpoint.
- [ ] **Step 5: Run `test-zrok-bootstrap` and confirm GREEN** with all old and new scenarios passing.

### Task 2: Runtime fallback to saved selection

**Files:**
- Modify: `src/server/services/zrokRuntimeService.ts`
- Test: `tests/server/zrokRuntimeService.test.ts`

**Interfaces:**
- Consumes: `.devflow/zrok-selection.json` with optional string `reservedName`.
- Produces: runtime default config `preferredName` precedence: environment override → saved local selection → undefined/discovery heuristics.

- [ ] **Step 1: Add failing runtime tests** proving a saved local selection disambiguates multiple reserved names and the environment override remains authoritative.
- [ ] **Step 2: Run `test-focused tests/server/zrokRuntimeService.test.ts` and confirm RED** because saved selection is not read.
- [ ] **Step 3: Implement a bounded local selection reader** through the DevFlow app/runtime root, rejecting malformed/non-string/oversized values and ignoring all unrelated fields.
- [ ] **Step 4: Wire the reader into default config precedence** without changing current live endpoint discovery or takeover behavior.
- [ ] **Step 5: Run focused runtime tests and confirm GREEN**.

### Task 3: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/runtime-supervisor.md`

**Interfaces:**
- Consumes: implemented setup behavior.
- Produces: operator documentation for first machine, another machine, saved selection, live endpoint discovery, Standby, and explicit Take over.

- [ ] **Step 1: Document the new machine flow** including token prompt only when enablement is needed and the non-secret local saved name.
- [ ] **Step 2: Run `test:absolute-paths` and `typecheck`**.
- [ ] **Step 3: Run `test-zrok-bootstrap` plus focused zrok runtime tests** as combined targeted verification.
- [ ] **Step 4: Commit task-owned changes** with `[DVF-0583] feat: add existing-or-new zrok one-click setup` and integrate locally into `develop` without pushing.
