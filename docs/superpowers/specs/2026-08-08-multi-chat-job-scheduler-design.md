# Multi-chat MCP job scheduler redesign

Date: 2026-08-08
Task: DVF-0354

## Problem

DevFlow currently uses `JobKind` as both execution category and repository lock semantics. `repo-command` and `repo-write` are counted as writers, so long read-only verification such as typecheck can block file reads, search, and context retrieval on the same repository for tens of seconds. The queue also uses a per-pass `blockedResources` shortcut that can create avoidable same-repo head-of-line blocking.

Observed behavior before this change: a `search_local_files` execution completed in 46 ms after waiting about 45.7 s in the repo queue while long repo commands were active.

## Goals

1. Safe verification and read-only work should run concurrently on the same repository.
2. Mutations remain exclusive and deterministic.
3. Verification that depends on a stable working tree must prevent conflicting writes until verification completes.
4. A queued writer must not starve behind an unbounded stream of later reads.
5. The scheduler should use bounded concurrency by work cost instead of one coarse limit.
6. Diagnostics must explain why a job is waiting.

## Access model

Separate execution kind from repository access mode.

- `read`: file/context/index reads that do not require a stable tree beyond the revision they read.
- `verify`: read-only command/process work. Compatible with `read`, bounded by a verification pool. Incompatible with mutations when stable-tree verification is required.
- `write`: edits, patches, branch/commit/push, and unknown/custom commands. Exclusive.

Compatibility matrix:

| Active / New | read | verify | write |
| --- | --- | --- | --- |
| read | yes | yes | no |
| verify | yes | yes, within pool | no |
| write | no | no | no |

Unknown or custom commands remain `write`/exclusive unless their resolved command metadata explicitly proves them safe for `verify` access.

## Cost pools

Use separate bounded pools:

- light read: 8 per repo
- process/search read: 4 per repo
- verify: 2 per repo
- write: 1 per repo

Pool values are conservative defaults and can be tuned later from telemetry. Raw write concurrency must stay 1.

## Queue fairness and writer barrier

Scheduling is per resource key. The scheduler may scan compatible jobs in queue order, but once it encounters the earliest queued writer for a repository, newer reads/verifications for that same repository may not bypass it. Compatible reads/verifications already ahead of the writer may start if capacity allows.

Example: `R1 R2 R3 W1 R4 R5` can start `R1..R3`; `R4/R5` wait behind `W1`. This removes avoidable head-of-line blocking while preventing writer starvation.

Different repositories remain independent.

## `run_project_command` classification

Expose a conservative command access classifier from `projectCommandService`.

Known built-in read-only verification presets such as typecheck/lint/test/verify may be classified as `verify` when their resolved command metadata is non-mutating. Repository-defined/custom commands default to exclusive unless explicitly marked resource-isolated/read-only by repository command metadata. Classification must be based on the resolved command, not just the user-provided alias.

Single-flight remains enabled for equivalent in-flight verification at the same execution identity.

## `apply_and_verify` phase semantics

`apply_and_verify` contains two semantic phases:

1. Mutation phase: exclusive `write` access while applying the edit and capturing the resulting revision/diff.
2. Verification phase: stable-tree `verify` access. Reads may run concurrently; conflicting writes remain blocked until this phase completes.

The scheduler must support an atomic access transition from `write` to `verify` without opening a window where another writer can mutate the tree between the edit and verification. The transition changes compatibility for reads but preserves the writer barrier against mutations until verification finishes.

This is a lock downgrade, not a full release/reacquire.

## Scheduler interfaces

`QueueEntry` gains explicit scheduler metadata such as:

- access mode
- cost class
- enqueue timestamp
- optional stable-tree/write-blocking requirement
- blocker metadata while queued

The active resource state tracks active counts by access/cost class instead of deriving everything from `JobKind`.

A controlled runner can request an atomic access-mode transition during execution. The transition must validate that it only reduces exclusivity (for this task, `write -> verify`) and update resource accounting before processing newly compatible queued work.

## Diagnostics

Expose enough data to diagnose multi-chat stalls:

- `queueAgeMs`
- persisted `waitMs`
- `accessMode`
- `costClass`
- `blockedByJobId` when identifiable
- `blockedByAccessMode` / blocker reason
- per-resource active counts
- queue depth and average wait/run metrics

The queue status API should return blocker information without requiring log inspection.

## Tests

Add deterministic scheduler tests for:

- verify + read concurrency on one repo
- bounded verify concurrency
- write exclusion against read and verify
- writer barrier preventing newer reads from bypassing a queued writer
- compatible jobs ahead of a writer using available capacity
- different repos remaining independent
- atomic `write -> verify` transition allowing reads but continuing to block writes
- blocker/queue-age telemetry
- existing single-flight behavior

`applyAndVerifyService` coverage must ensure the edit is complete before verification starts and revision/stable-tree guarantees are preserved.

## Benchmark

Extend the verification benchmark with a multi-chat workload: one long safe verification plus several same-repo read/search jobs. Record execution time and queue wait. Success means read queue wait is reduced from being coupled to verification duration to near-normal read latency, while write safety tests remain green.

## Non-goals

- Increasing concurrent write count above 1.
- Allowing arbitrary custom commands to run concurrently by default.
- Replacing ngrok/SSE transport.
- Global cross-repo serialization.
