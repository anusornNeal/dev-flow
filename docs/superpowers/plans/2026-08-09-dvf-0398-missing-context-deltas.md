# DVF-0398 Missing-context Deltas and Quality Benchmark Plan

**Goal:** Reuse valid repo-context handles as a known-evidence ledger, recover from insufficient initial context with a concrete bounded delta, and benchmark payload savings together with recovery correctness/cost.

## Architecture
- Keep the existing context handle as the session-scoped known-context identity; do not introduce a second execution-session store in this card.
- Add a bounded missing-context request shape: `contextSufficient=false` plus concrete missing files/symbols/tests/relationships.
- Missing file/test evidence is read directly and capped; missing symbol evidence is searched then read around the matching line; relationship evidence uses the existing repo index with a small cross-module budget.
- Every returned follow-up snippet carries an evidence key and revision. The handle remembers delivered key+revision pairs so identical unchanged evidence is not resent.
- A changed file revision invalidates only evidence from that file because the same evidence key now has a different revision.
- An insufficient request without concrete missing evidence returns a structured `specific-evidence-required` response rather than broadening context automatically.

## Safety bounds
- Max 8 values per missing-evidence category and max 24 total request items.
- Max 8 returned snippets, max 8 KB each, bounded search/index limits.
- No full-file auto escalation; full files remain explicit `read_local_file` follow-ups.
- Missing-context fields do not participate in handle identity; planner intent/deep/target fields still do.

## TDD tasks
1. Add a fixture with a deep symbol outside the initial leading snippet.
2. Prove initial full context then unchanged `NOT_MODIFIED` is smaller.
3. Prove `missingSymbols` returns one symbol-centered narrow delta and records it as known evidence.
4. Repeat the request and prove unchanged evidence is not resent.
5. Edit the target file and prove only the requested revised evidence refreshes.
6. Prove `contextSufficient=false` without concrete evidence does not trigger broad inspection.
7. Add delta MCP schema fields and keep planner identity fields available on delta calls.
8. Add a benchmark script/report for bytes/tokens/follow-up calls/recovery success and savings.
9. Run focused handle/context/contract tests plus targeted TypeScript compile; record unrelated full-repo blockers separately.
