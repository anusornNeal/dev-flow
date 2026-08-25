# zrok Switch Here Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit one-click `Switch here` action that releases an active remote zrok share and activates the current DevFlow runtime when remote fencing is unsupported.

**Architecture:** Preserve the existing safe takeover path. Add a separate runtime transition and route for account-level release, guarded by a fresh exact binding check and serialized with takeover. Extend the existing status actionability contract and render a destructive confirmation action in the existing zrok panel.

**Tech Stack:** TypeScript, Express, React, Node test runner, tsx.

**Spec:** `docs/superpowers/specs/2026-08-25-zrok-switch-here-design.md`

## Global Constraints

- Never mutate ownership from polling or Recheck.
- Never expose zrok credentials or share tokens.
- Do not report success until the final public route reaches this runtime.
- Preserve the existing authenticated remote-fencing takeover behavior.

### Task 1: Runtime force-switch contract and implementation

**Files:**
- Modify: `src/server/services/zrokRuntimeService.ts`
- Test: `tests/server/zrokRuntimeService.test.ts`

**Steps:**

- [x] Add a failing test that an un-enrolled/unsupported remote owner exposes `canSwitchHere` and `switchHere()` deletes the exact remote share, starts the local share, and returns verified success.
- [x] Add failing tests for binding drift, delete failure, local-start failure, final probe failure, and concurrent takeover/switch serialization.
- [x] Run the focused runtime suite and confirm the new tests fail for missing switch behavior.
- [x] Add `canSwitchHere` to the status actionability contract and add a `switchHere()` runtime method/result codes without changing safe takeover semantics.
- [x] Reuse `deleteShare`, `startLocalShare`, existing discovery, exact-binding checks, and final public verification; serialize both transitions with one in-flight promise.
- [x] Run the focused runtime suite and confirm all tests pass.

### Task 2: HTTP route

**Files:**
- Modify: `src/server/routes/zrok.ts`
- Test: `tests/server/zrokRoutes.test.ts`

**Steps:**

- [x] Add a failing route test for `POST /api/zrok/switch-here` delegating to the runtime and returning its sanitized result.
- [x] Add failure status mapping tests for unavailable/stale, throttled/delete, and local/probe failures.
- [x] Run the route suite and confirm red.
- [x] Add the route and status mapping while preserving the existing takeover route.
- [x] Run the route suite and confirm green.

### Task 3: Status panel UI

**Files:**
- Modify: `src/components/ZrokStatusPanel.tsx`
- Test: `tests/components/zrokStatusPanel.test.tsx`

**Steps:**

- [x] Add failing component tests for `Switch here` visibility when `canSwitchHere` is true, hidden otherwise, confirmation requirement, busy text, and failure messaging.
- [x] Run the component suite and confirm red.
- [x] Add the request helper, explicit browser confirmation, busy/error/success state, and actionability normalization/rendering.
- [x] Run the component suite and confirm green.

### Task 4: Verification

**Files:** None.

**Steps:**

- [x] Run `npx tsx --test tests/server/zrokRuntimeService.test.ts`.
- [x] Run `npx tsx --test tests/server/zrokRoutes.test.ts`.
- [x] Run `npx tsx --test tests/components/zrokStatusPanel.test.tsx`.
- [x] Run `npx tsc --noEmit`.
- [x] Run `git diff --check` and inspect untracked/generated files.
