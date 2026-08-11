# DevFlow Authoring Core

## Purpose
Write concise, implementation-ready DevFlow cards from user intent plus bounded repository evidence. This is the common authoring policy. Source-specific evidence, decomposition, review, implementation, verification, and workspace execution belong to specialist skills.

## Non-negotiable rule
Do not guess implementation details that the repository can answer. When a project is known, inspect current repository evidence before creating or materially rewriting an implementation-ready card.

## Clarification gate
Ask only when a missing product decision materially changes scope, behavior, data contract, or acceptance criteria. Do not ask for details that bounded repository evidence can resolve. If the user delegates reasonable implementation decisions, record the chosen boundary and proceed.

## Bounded repo inspection
Use `get_repo_context_bundle` first when a project is known. Search or read exact targets only when that packet is insufficient.

Do not scan or read the whole repo. Prefer the smallest evidence set that identifies:
- the affected flow or component;
- likely target files and symbols;
- direct callers or dependencies when relevant;
- current behavior;
- the smallest safe change location;
- nearest tests or verification targets;
- important out-of-scope behavior.

Stop reading once the card can state focused target files, current behavior, expected change, acceptance criteria, and verification without guessing. If bounded inspection cannot identify a credible implementation path, author a blocked/preparation card rather than inventing one.

## Implementation map
Implementation-ready cards should connect requirements to concrete code areas in `repoContext`:

```text
Implementation map:
- File: <repo-relative path>
  Class/function: <symbol when known>
  Current behavior: <what exists now>
  Expected change: <the requested delta>
```

Keep `targetFiles` aligned with the implementation map. Use repository-relative paths and avoid machine-specific local paths.

## Deep analysis before writing
Resolve the implementation delta, not only the feature theme:
- what currently happens;
- what must change;
- what must remain unchanged;
- important failure, empty, loading, concurrency, or boundary cases when relevant;
- dependencies and proof needed for completion.

Do not copy the same requirement prose into every field.

## Delta rule
A card describes the delta from current behavior. Preserve existing behavior unless the requirement explicitly changes it. When updating a card, merge new evidence into the current truth and remove superseded assumptions instead of stacking contradictions.

## Scope rule
One card should represent one coherent implementation boundary. If independent work can be implemented, verified, reviewed, or owned separately, decompose it rather than hiding separate work inside a long checklist.

## Wording and copy rule
Use observable product and engineering language. Avoid vague verbs such as “support”, “handle”, or “improve” without stating what changes. Preserve exact user-facing copy when supplied; otherwise describe behavior rather than inventing final wording.

## Field quality
- `title`: short implementation outcome.
- `description`: requested behavior, scope delta, and important exclusions.
- `repoContext`: implementation map, current-code findings, dependencies, and constraints.
- `targetFiles`: focused repo-relative implementation and test paths supported by evidence.
- `checklist`: milestones inside this card, not substitute child cards.
- `acceptanceCriteria`: observable pass/fail outcomes including important negative behavior.
- `verification`: concrete automated or manual evidence that proves the criteria.
- `reasoning`: boundary or approach rationale when it helps the implementer.

## Acceptance criteria
Make criteria observable from UI, API, state, generated artifacts, logs, or tests. Include what must not happen when regressions or preserved behavior matter.

## Verification authoring
Name the smallest useful proof first. Describe what each verification step demonstrates rather than writing only “tests pass.” Execution policy belongs to the execution specialist.

## Status rule
Default card status is `backlog`. Do not set `todo` merely because a card is implementation-ready; move it only when the user or workflow actually queues or starts work.

## Quality gate
Before task mutation, ensure the card is implementable without broad rediscovery: focused scope, implementation map when applicable, observable acceptance criteria, and concrete verification. Server-side task mutation validation remains authoritative.
