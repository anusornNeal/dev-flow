# DevFlow Authoring Decomposition Specialist

## Purpose
Load only when the requested work is large enough that one card would hide independent implementation, verification, review, or ownership boundaries.

## Subtask-first decomposition
Prefer a parent plus focused child cards when the work contains independent implementation units. The parent owns outcome, orchestration, dependencies, shared constraints, and final integration evidence; children own concrete implementation slices.

Do not hide real subtask work inside a long checklist. A checklist is for milestones inside one coherent implementation boundary, not a substitute for cards that can be implemented or reviewed independently.

Create separate cards when:
- parts can be implemented or verified independently;
- different modules/files have distinct failure modes or ownership;
- one part is a prerequisite for another;
- frontend and backend can progress independently;
- rollout/migration/measurement is independently testable;
- a parent would otherwise contain multiple separate commit scopes.

Keep one card when the changes are tightly coupled, share one implementation/test boundary, and splitting would create artificial coordination overhead.

## Frontend/backend split
Split frontend/backend work when contracts and implementation can be developed or reviewed separately. Record the shared API/data contract and dependency direction explicitly.

Do not split merely because both frontend and backend files are touched. Keep one general card when a single atomic behavior requires both sides to change together and cannot be meaningfully verified separately.

## Parent rules
- Parent describes the end-to-end outcome and dependency graph, not a duplicate copy of every child detail.
- Parent checklist tracks child completion/integration milestones.
- Parent verification owns final integrated evidence when appropriate.
- Child `parentId` must reference the real parent.

## Child rules
Each child still needs focused `targetFiles`, an implementation map, observable acceptance criteria, and concrete verification. Do not rely on the parent for implementation-critical details that the child needs to execute safely.

## Dependency ordering
State prerequisites explicitly. Work that can run in parallel should not be serialized by wording alone. Work that depends on a schema/contract/migration should declare that dependency so the orchestrator can schedule it correctly.

## Status rule
Unless the user/workflow explicitly queues or starts implementation, keep every newly authored parent and child in `backlog` by default.
