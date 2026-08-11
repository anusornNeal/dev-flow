# DevFlow Skills

DevFlow keeps authoring/execution policy and the manual worker prompt separate so each surface can stay small and authoritative.

## Authoring and execution skills

Start with `00-skill-router.md`, then load only the specialist it selects:

- `01-authoring-core.md` — implementation-ready card authoring.
- `02-schema-reference.md` — semantic task-field placement when live schemas are insufficient.
- `03-reviewer-core.md` — review and existing-task defect handling.
- `04-examples.md` — examples only.
- `05-authoring-evidence.md` — Jira/Figma/Atlas/source evidence.
- `06-authoring-decomposition.md` — parent/child boundaries and parallel slices.
- `07-authoring-execution.md` — repository implementation, verification, task-owned commit, and workspace lifecycle.
- `08-board-loop-execution.md` — continuous board-loop orchestration.

Master skills are authoritative policy. Compatibility files and examples do not override them.

## Manual worker prompt

The card Copy Prompt action produces one engine-agnostic implementation bootstrap. Its only production source is `config/prompt-pipeline.json` plus the `skills/prompt.*.md` sections listed by that pipeline.

The bootstrap intentionally stays small: it identifies the card, tells the worker to load compact `get_task(mode="agent-context")` context through the live DevFlow tool surface, establishes the minimum execution/completion contract, and leaves large task/design/repository data to on-demand reads.

`agent-task-prompt-template.md` is a non-authoritative compatibility pointer. Codex, Antigravity, and Claude workflow documents may describe optional/legacy CLI launch behavior, but they do not define different task prompts.
