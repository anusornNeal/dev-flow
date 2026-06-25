# Codex Auto Work Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a preflight gate that blocks Auto Work launches before handoff when task, project, agent config, scripts, executable, or run artifact paths are invalid.

**Architecture:** Keep the launch lifecycle intact and add a small shared preflight layer ahead of `triggerTaskAgent`. Return structured `code/message` failures from the API and surface the most useful failure to the UI without changing runner completion flow.

**Tech Stack:** TypeScript, Express, React, Node `fs`/`path`, existing verification scripts.

---

### Task 1: Add failing preflight coverage

**Files:**
- Modify: `scripts/verify-agent-runs.ts`
- Test: `scripts/verify-agent-runs.ts`

- [ ] Add assertions for missing project path, missing trigger script, missing executable, and successful preflight.
- [ ] Run `npm run test:agent-runs` and verify the new assertions fail before implementation.

### Task 2: Implement shared preflight helpers

**Files:**
- Modify: `src/server/services/agentLaunchConfig.ts`
- Modify: `src/server/services/agentRunService.ts`
- Modify: `src/runner.ts`

- [ ] Add a structured preflight result type plus helper(s) that validate agent config, local path, trigger scripts, executable resolution, and run artifact directory readiness.
- [ ] Reuse the executable resolution logic from shared code so server preflight and runner stay aligned.
- [ ] Re-run `npm run test:agent-runs` and verify the new checks pass.

### Task 3: Block launch and surface readable failures

**Files:**
- Modify: `src/server/routes/tasks.ts`
- Modify: `src/components/AutoWorkToggle.tsx`

- [ ] Call preflight before creating or starting an agent run and return structured `code/message` failures from trigger paths.
- [ ] Surface the failure to the UI in the existing header controls without changing queue, runner lifecycle, or completion callbacks.
- [ ] Run `npm run build`, `npm run test`, and `npm run lint`.
