# Agent Task Prompt Template (Compatibility Pointer)

This file is non-authoritative compatibility documentation. It does not define the prompt copied from a DevFlow card.

The single production manual-worker prompt is composed from `config/prompt-pipeline.json` and the `skills/prompt.*.md` sections listed by that pipeline. Codex, Antigravity, Claude, and other DevFlow-connected implementation engines receive the same engine-agnostic worker bootstrap.

Do not add task requirements, engine-specific launch flags, Git policy, or completion rules here. Update the canonical pipeline sections instead.
