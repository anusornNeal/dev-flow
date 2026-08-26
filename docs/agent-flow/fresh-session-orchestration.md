# Codex Copy Prompt and Legacy Fresh-Session Orchestration

## Current Copy Prompt contract

The card **Copy Prompt** action is a Codex handoff. It is not the managed ChatGPT/@devflowz execution path and it is not an engine selector.

1. The user clicks **Copy for Codex** on a DevFlow card.
2. DevFlow renders the `codex` prompt pipeline from authoritative card data.
3. The user pastes that prompt into Codex.
4. Codex independently investigates the repository, reads repository-native instructions, plans, edits files, runs shell commands/tests/builds, uses native Git, creates commits when appropriate, and decides when the repository task is complete.
5. If available, Codex may call `update_external_task_status` to synchronize the DevFlow card. That synchronization is advisory only.

A live DevFlow connection is not required after the prompt has been copied. If board synchronization is unavailable or fails, Codex continues repository work. A status-sync failure must not cause rollback, repeated verification, abandonment of a valid commit, or rerouting repository execution through DevFlow.

## Agent-neutral orchestration action/result contract

DevFlow's provider-neutral boundary is workflow state, not `agent.run(prompt)` and not a shared execution harness. A disposable reasoning worker receives an action envelope keyed by canonical `projectId` + `taskId` with one action: `IMPLEMENT_TASK`, `RESOLVE_FAILURE`, `RESOLVE_CONFLICT`, `REVIEW_TASK`, or `INVESTIGATE`. The worker reports one normalized result state: `HANDOFF_READY`, `BLOCKED`, `NEEDS_CONTEXT`, or `COMPLETE`.

The envelope records an execution adapter, not an engine assumption. `devflow-managed` keeps repository execution under DevFlow claims/workspaces/tool jobs; `worker-native` leaves repository/filesystem/shell/Git execution to the worker; `legacy-launcher` exists only for compatibility. Run/session identity is disposable. DevFlow remains the canonical owner of task/orchestration state, so a replacement worker reconstructs its next action from durable DevFlow state rather than replaying a prior prompt or mutation.

Normalized action results are **orchestration-only evidence**. They may move or explain workflow state, but they cannot satisfy managed verification freshness, task-owned commit proof, Git integration evidence, or finalization requirements. Those authoritative managed channels remain separate even when a managed worker returns `COMPLETE`. External/native commit and verification text likewise stays informational.

`HANDOFF_READY` means the current worker yielded at a safe reasoning boundary; `BLOCKED` means known conditions prevent progress; `NEEDS_CONTEXT` means more information is required before reasoning continues; `COMPLETE` means the worker believes its assigned reasoning/repository scope is complete. None of these states grants repository execution authority by itself.

For local-native workers, `update_external_task_status` is the bridge into this contract. A worker may attach bounded `worker`, `action`, `resultState`, and `contextRef` metadata while continuing to use its own filesystem/shell/test/Git harness. Plain `in-progress` means the native worker is actively executing the reported action. `BLOCKED`, `NEEDS_CONTEXT`, or `HANDOFF_READY` keep the task in-progress but project it as scheduler attention so a later compatible worker can resume from the durable task/context reference. `COMPLETE` is reported with `ready-for-review` or `done`.

An external in-progress task reserves its authored target-file scope for orchestration collision checks even though it has no managed claim/workspace. This reservation prevents DevFlow from scheduling overlapping managed work; it does not create managed lifecycle authority or restrict how the native worker executes repository operations. If DevFlow connectivity is lost, the local repository result remains valid and the next successful sync reconstructs orchestration state from the task record.

A plain working snapshot is treated as a heartbeat: if it is not refreshed for 30 minutes, DevFlow projects `Disconnected` / `EXTERNAL_NATIVE_WORKER_STALE` attention while retaining the target-file reservation and durable `contextRef`. Explicit `BLOCKED`, `NEEDS_CONTEXT`, and `HANDOFF_READY` results are already durable attention boundaries and do not expire into disconnected state. A replacement worker resumes by reading that durable task/attention context and writing a new external status snapshot; no previous chat/session identity is required.

## Prompt authority and isolation

The production Copy Prompt source is the `codex` pipeline in `config/prompt-pipeline.json` and its `skills/prompt.codex-*.md` sections. The rendered task context contains card-authored implementation information such as title, description, reasoning, acceptance criteria, checklist, verification guidance, target files, repository context, references, and bounded design/image evidence when present.

The current Codex Copy Prompt must **not** auto-inject execution state or project-local DevFlow policy. In particular it does not inject:

- `.devflow/agents.md` or root/project DevFlow instruction overlays,
- `.devflow/prompt-overrides/*`,
- active/latest agent-run identity,
- managed workspace paths or workspace authority,
- claim/ownership epoch or lifecycle state,
- managed verification/finalization requirements,
- DevFlow repository read/edit/command requirements that are not card-authored task data.

This isolation is deliberate: DevFlow authors the task and may mirror board status; Codex owns repository execution after handoff.

## ChatGPT/@devflowz remains managed

ChatGPT/@devflowz execution is a separate first-class workflow. It may use DevFlow claims, managed workspaces, execution ownership, verification freshness, task-owned commits, integration, finalization, recovery, and board-loop policy. The Codex Copy Prompt path does not weaken or replace those controls, and managed execution controls do not become prerequisites for Codex repository work.

## Completion

For Codex Copy Prompt, repository completion is judged by Codex from the task requirements and the verification it performs in the repository. `update_external_task_status` may report `in-progress`, `ready-for-review`, or `done`, including informational summary/commit/verification metadata, but those fields do not become authoritative DevFlow Git or verification evidence.

For ChatGPT/@devflowz managed execution, completion continues to follow the managed lifecycle and finalization contract.

## Historical auto-launch behavior

Older DevFlow builds included fresh-process agent launchers, managed Codex workspaces, agent-run callbacks, auto-work continuation, CLI-specific launch flags, and prompt files generated per run. Those paths remain **compatibility-only quarantined behavior**, not the default local-native adapter. They may stay for explicitly supported Auto Work/legacy features until separate removal evidence proves they are unused, but new orchestration must not depend on them. Do not copy their managed-workspace or finalization requirements into the Codex handoff prompt.

## Phase 0 architecture inventory

This inventory is the migration boundary for the durable agent-neutral orchestration work. It records what is authoritative today, what still has live consumers, and which historical paths must not be duplicated by the new control plane. Classification here is evidence-based; grep presence alone is never a removal reason.

### Current authority map

| Concern | Current authoritative path | Current consumer / evidence | Classification |
| --- | --- | --- | --- |
| Managed ChatGPT task selection and ownership | `src/server/routes/taskClaimRoutes.ts` -> `src/server/services/taskClaimService.ts` (`claimNextTaskForSession`, `claimTaskForSession`, scope expansion/release) | ChatGPT/@devflowz `claim_next_task` / `claim_task`; successful claims bind task ownership and managed workspace state | **KEEP** |
| Managed execution state | `executionSessionRepository`, `executionCheckpointService`, `lifecycleAuthorityService`, managed workspace services | Managed claim/execution lifecycle, health/recovery, commit/finalization guards | **KEEP** |
| Durable continuation after tool/job boundaries | `src/server/services/executionContinuationService.ts` | Evaluates pending MCP jobs, incomplete finalization, recovery, committed-but-not-finalized state and returns the exact continuation action | **KEEP**; reuse rather than inventing another continuation state machine |
| Managed terminal integration | `src/server/services/taskWorkspaceFinalizationService.ts` exposed by `src/server/routes/devflow.ts` as `finalize_task_workspace` | Managed ChatGPT completion and break-glass recovery both call the same finalizer | **KEEP** |
| Autonomous Codex/local-native handoff | `config/prompt-pipeline.json`, `skills/prompt.codex-*.md`, Copy Prompt route, then native Codex repository tools | Card Copy for Codex; no live DevFlow repository-execution dependency after copy | **KEEP** as an execution boundary, not a scheduler |
| Best-effort external board synchronization | `src/server/services/externalTaskStatusService.ts` via `src/server/routes/taskWorkflowRoutes.ts`; MCP contract `update_external_task_status` | Codex may mirror `in-progress`, `ready-for-review`, or `done`; metadata is informational | **KEEP**; must stay advisory and must not become managed lifecycle evidence |
| Board live-work projection | `src/server/services/taskBoardLiveWorkProjectionService.ts` -> `projectTaskBoardLiveWork()` -> `taskRouteSupport.toTaskResponse()` | Task board/task detail payloads; `TaskCard` consumes `task.liveWork` before falling back to legacy agent state | **KEEP / EXTEND** as the projection seam for Agent Office/live monitoring |
| Legacy launched-agent orchestration | `AgentOrchestrationWorker`, `taskRouteSupport.triggerTaskAgent()` / `maybeTriggerTaskAgent()`, `taskLegacyAgentRoutes.ts` | Task create/update/batch/set-authoring hooks and retry/completion routes still invoke it | **REPLACE**, but not removable yet because live mutation routes still call it |
| Legacy Auto Work queue | `taskRouteSupport.continueTaskQueueForProject()` plus `settings.ts` and completion callbacks | Enabling `settings.autoWork` immediately scans assigned `todo` tasks; successful legacy runs continue the queue | **REPLACE**; this is existing scheduler-like behavior that a new dispatcher must supersede, never run beside |
| Auto Work UI/config | `src/components/AutoWorkToggle.tsx`, `settingsRepository.ts`, `/api/settings` | User-visible toggle persists `autoWork` and starts legacy queue execution | **DEPRECATE** after the replacement orchestration control is user-visible and migration-safe |
| Legacy run history/log API | `src/server/routes/taskLegacyAgentRoutes.ts` and `agentRunRepository`/`agentRunService` | Task drawer/activity and compatibility tooling can still inspect latest/history/logs and retry/cancel old runs | **DEPRECATE / SPLIT**; retain read compatibility until Agent Office exposes equivalent history, retire launcher mutations separately |

### Managed ChatGPT boundary

The managed ChatGPT path is claim-centric, not agent-run-centric:

`claim_next_task / claim_task` -> task claim + managed workspace -> execution session/checkpoints -> repository edits -> frozen verification evidence -> task-owned commit -> `finalize_task_workspace` -> integration/task completion/cleanup.

`executionContinuationService` is the existing durable bridge when that sequence crosses a long-running tool job or interrupted finalization. Future orchestration must consume or compose this state instead of creating a second "is this execution finished?" state machine.

The legacy `agentRun` record is therefore **not** the authoritative owner of a managed ChatGPT execution. `taskBoardLiveWorkProjectionService` already expresses this priority: when a valid managed claim and matching execution session exist, it projects managed lifecycle/checkpoint state; only when that evidence is absent does it fall back to external/legacy agent-run state.

### External/local-native boundary

For the current product, Copy for Codex is the authoritative autonomous local-native path. DevFlow authors the bounded task handoff, then Codex owns repository investigation, edits, commands, verification, Git and completion. `update_external_task_status` is a best-effort presentation sync only.

Historical DevFlow-launched Codex/agent execution is a different path. `AgentOrchestrationWorker` still has real callers, so it cannot be called dead code, but it is compatibility orchestration rather than the authority for Copy for Codex. Future local-native agent support should follow the autonomous handoff/status-sync boundary unless a later phase intentionally defines a durable dispatcher contract.

### Existing scheduler-like behavior that must not be duplicated

There are two active legacy scheduling entry points:

1. **Mutation-triggered launch.** `maybeTriggerTaskAgent()` runs when an assigned task reaches `todo` or its assignment changes, and several task create/update/batch routes call `AgentOrchestrationWorker.maybeTrigger(...)`.
2. **Queue continuation.** `continueTaskQueueForProject()` selects project `todo` tasks with an assigned agent, sorts oldest first, skips tasks whose latest run failed, and attempts to launch every eligible task that is not blocked by per-agent concurrency. `settings.ts` calls this across projects when Auto Work is enabled, and successful legacy completion callbacks call it again.

A new scheduler/dispatcher must first establish one cut-over owner for these decisions. Running a new polling/event scheduler while either legacy entry point can still launch work would create duplicate starts, contradictory concurrency policy, and two different definitions of "next task".

### Retirement matrix

| Candidate | Decision | Evidence it is still live | Replacement / retirement condition |
| --- | --- | --- | --- |
| `taskClaimService` managed claim APIs | **KEEP** | Current board-loop and managed ChatGPT ownership use them | No retirement planned; new orchestration should compose them |
| `executionContinuationService` | **KEEP** | Encodes pending durable-job/finalization/recovery continuation | Retire only if its contract is fully absorbed by a single proven successor with the same durable evidence semantics |
| `taskBoardLiveWorkProjectionService` | **KEEP / EXTEND** | Task responses and current board UI consume `liveWork` | Evolve into agent-neutral projection; do not fork a second live-state projection |
| `externalTaskStatusService` / `update_external_task_status` | **KEEP** | Codex autonomous handoff uses optional board sync | Keep while external/native workers exist; never upgrade informational metadata into managed proof |
| `continueTaskQueueForProject()` | **REPLACE** | Called by settings enable and successful legacy run callbacks | Disable legacy launch ownership only after new dispatcher has equivalent eligibility/concurrency tests and one explicit cut-over flag/state |
| `maybeTriggerTaskAgent()` and mutation-route `AgentOrchestrationWorker.maybeTrigger()` calls | **REPLACE** | Called from task create/update/batch/set-authoring paths | Remove trigger hooks only after the new dispatcher is the sole owner of start decisions and duplicate-start tests pass |
| `AutoWorkToggle` + `settings.autoWork` | **DEPRECATE** | User-facing toggle still persists state and starts work | Remove after replacement orchestration controls are shipped, migrated settings are handled, and no API/UI caller reads the old flag |
| `taskLegacyAgentRoutes` launcher mutations (retry/cancel/completion) | **DEPRECATE** | Registered by `tasks.ts`; active run compatibility uses them | Split read/history from mutation endpoints; remove mutations after no supported execution path creates legacy runs |
| Legacy agent-run history/log reads | **REMOVE-LATER** or migrate | Task activity UI/history still has consumers | Remove only after equivalent Agent Office/history projection exists and all UI/API callers migrate |
| Fresh-process launcher/config/run-file plumbing in `agentRunService` / `agentLaunchConfig` | **REMOVE-LATER** | Still reached by `AgentOrchestrationWorker.trigger()` | Delete only after all launcher mutations are retired, tests/contracts no longer require run files, and repository search confirms no runtime caller |

### Dependency graph for migration phases

```text
Task/card authoring
  |-- managed ChatGPT -----------------------------+
  |    claim/taskClaimService                     |
  |      -> managed workspace                     |
  |      -> execution session/checkpoint          |
  |      -> lifecycle authority                   |
  |      -> durable tool jobs                     |
  |      -> executionContinuationService          |
  |      -> task-owned commit                     |
  |      -> taskWorkspaceFinalizationService -----+--> task status / Git integrated state
  |
  |-- Copy for Codex / autonomous native agent
  |      -> prompt pipeline
  |      -> native repository execution
  |      -> optional externalTaskStatusService ------> board presentation only
  |
  `-- legacy Auto Work compatibility
         task mutation hooks / settings toggle
           -> continueTaskQueueForProject / maybeTriggerTaskAgent
           -> AgentOrchestrationWorker
           -> legacy agentRun + launcher files
           -> completion callback
           `-> queue continuation

Task board response
  -> taskBoardLiveWorkProjectionService
       -> managed claim/execution/checkpoint first
       `-> legacy/external agentRun fallback
```

### Migration hazards

- **Double scheduling:** legacy Auto Work can launch from both task mutations and queue continuation; a new dispatcher must not be enabled in parallel without a single ownership gate.
- **State-source confusion:** `agentRun`, managed execution sessions/checkpoints, task claims and external status metadata represent different trust levels. Do not collapse them into one writable record.
- **False completion:** external-native `done` sync is presentation state; managed ChatGPT still needs verification/commit/finalization evidence.
- **UI regression:** removing legacy run fields before `liveWork`/Agent Office covers history, blocked state and external-native work would make activity less observable.
- **Recovery regression:** new orchestration must preserve durable MCP job/finalization continuation and must never replay accepted mutations just because a client reconnects.
- **Cleanup by grep:** legacy files have broad imports and user-visible settings today. Retirement requires caller migration plus a measurable cut-over condition, not a low reference count.

### Phase 7 cleanup gate

Broad cleanup is intentionally deferred. A candidate can move from **DEPRECATE/REMOVE-LATER** to deletion only when all of the following are true: the replacement path is live, runtime callers are migrated, relevant UI/API contracts no longer expose the legacy behavior, focused regression tests cover the replacement, and a bounded repository search shows no supported runtime consumer. Historical docs may then be archived or rewritten, but evidence needed to explain migrations should be retained.

