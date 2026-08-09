# DVF-0397 Intent-aware Context Budget Planner

**Goal:** Make `get_repo_context_bundle` choose the smallest useful evidence/budget for the caller intent while keeping explicit caller limits backward compatible and allowing deliberate deep/architecture escalation.

## Architecture
- Add a pure deterministic `contextBudgetPlanner` that infers/accepts intent, chooses a disclosure profile, ranks search candidates as Must/Should/Optional with reasons, and returns byte/token budgets.
- `getRepoContextBundle` uses planner defaults only when the caller did not explicitly provide limits.
- Existing repo-index/revision data remains the source of file/symbol/freshness evidence; no duplicate scanner is introduced.
- Full files are never auto-embedded by the planner. Deep/architecture plans may *allow/recommend* explicit `read_local_file` escalation.
- Context-handle identity includes planner inputs so a small-bug handle cannot be reused for architecture/deep context.

## TDD tasks
1. Pure planner fixtures: authoring/config, one-function bug, verification/debugging, cross-module, architecture; assert deterministic intent/disclosure/budgets.
2. Candidate ranking: explicit target → Must, query path/symbol and verification tests → Must/Should, remaining evidence → Optional, each with reasons.
3. Integration: default simple bundle uses smaller limits than architecture; explicit caller limits remain unchanged; result includes `contextPlan` and snippet evidence rank/reasons/revision.
4. Context-handle identity: changing intent/deep/targetFiles produces a new full bundle rather than NOT_MODIFIED reuse.
5. Contract: expose `intent`, `complexity`, `targetFiles`, `deep`, and `disclosureLevel` on `get_repo_context_bundle`.
6. Verification: planner + context + index + context-handle tests, targeted TypeScript compile, and payload-size comparison.
