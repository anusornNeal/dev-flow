# DevFlow Authoring Decomposition Specialist

## Purpose
Load this skill when one card would hide independent implementation, verification, review, or ownership boundaries.

## Subtask-first decomposition
Prefer a parent plus focused child cards when the work contains independent implementation units. The parent owns the end-to-end outcome, shared constraints, dependency graph, and final integration evidence; children own concrete implementation slices.

Do not hide real subtask work inside a long checklist. A checklist is for milestones inside one coherent implementation boundary, not a substitute for cards that can be implemented or reviewed independently.

Create separate cards when:
- parts can be implemented or verified independently;
- different modules or files have distinct failure modes or ownership;
- one slice is a real prerequisite for another;
- frontend and backend can progress independently;
- rollout, migration, or measurement is independently testable;
- one parent would otherwise contain multiple separate commit scopes.

Keep one card when changes are tightly coupled, share one implementation/test boundary, and splitting would create artificial coordination overhead.

## Parallel child semantics
Independent children are parallel by default when their target scope is disjoint and no real dependency blocks them. Sharing a parent does not serialize siblings.

Do not invent ordering because cards were authored sequentially. State a prerequisite only when one child truly needs another child's contract, migration, generated artifact, integrated state, or other completed output before it can proceed safely.

When the task-set tool supports structured prerequisites, persist real DAG edges through `prerequisiteTaskIds` using stable request-local `taskSetKey` references. Checklist prose may explain a dependency, but it must not be the only scheduling representation. Persisted dependencies resolve to canonical same-project task IDs.

When target files overlap materially, call out the ownership boundary or dependency so orchestration can avoid concurrent conflicting edits.

## Frontend/backend split
Split frontend/backend work when the contract and each implementation slice can be developed, verified, or reviewed separately. Record the shared contract and prerequisite direction explicitly.

Do not split merely because both frontend and backend files are touched. Keep one general card when one atomic behavior requires both sides to change together and cannot be meaningfully verified separately.

## Parent rules
- Describe the final outcome and dependency graph, not a duplicate copy of every child detail.
- Track child completion and integration milestones.
- Own final combined verification when appropriate.
- Keep child boundaries focused enough to allow safe parallel ownership.

## Child rules
Each child still needs focused `targetFiles`, an implementation map, observable acceptance criteria, and concrete verification. Do not rely on the parent for implementation-critical details the child needs to execute safely.

## Status rule
Unless the user or workflow explicitly queues or starts implementation, keep newly authored parent and child cards in `backlog`.
