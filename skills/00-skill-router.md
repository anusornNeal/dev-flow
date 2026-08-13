# DevFlow Skill Router

## Purpose
Choose the smallest DevFlow guidance set that matches the current action. This file only routes; it does not duplicate specialist policy.

## Decision flow
1. **Ordinary card authoring** — load `01-authoring-core` only. Use it when the request is clear and does not require source-specific evidence, decomposition, implementation, review, or schema semantics.
2. **Semantic task-field question** — load `02-schema-reference` only when the live structural schema cannot answer where information belongs. For exact fields, enums, required values, aliases, or nested shapes, use `get_tool_schema` instead of loading more prose.
3. **Review or an existing-task defect** — load `03-reviewer-core`. It owns ready-for-review decisions, review evidence, corrected assumptions, and embedded defect handling.
4. **Concrete sample needed** — load `04-examples` only for an example payload, card shape, or parent/child illustration. Examples never override policy.
5. **Jira, Figma, Atlas, or other source evidence** — add `05-authoring-evidence` to the ordinary authoring path. It owns source provenance and evidence authority.
6. **Large or independently executable scope** — add `06-authoring-decomposition`. It owns parent/child boundaries, parallel slices, and prerequisite direction.
7. **Repository implementation** — load `07-authoring-execution` when the task continues into local edits, tests, verification, commit, workspace lifecycle, or recovery.
8. **Continuous board work** — load `08-board-loop-execution` for loop-board / keep-taking-work requests. It owns claim selection and orchestration; implementation details stay delegated to the execution specialist.
9. **Creative feature or behavior design** — load `brainstorming-guidance` on demand before implementation when the request needs exploration, alternatives, trade-offs, or an approval gate.
10. **UI/UX work** — load `ui-ux-guidance` on demand for screens, layout, visual hierarchy, interaction, navigation, accessibility, animation, responsive behavior, or data presentation. For a new UI feature, load `brainstorming-guidance` first and `ui-ux-guidance` second.

## Routing rules
- Load only the minimum set needed for the current action.
- Retrieve guidance skills through `get_guidance_skill`; they are advisory and do not override DevFlow execution, verification, commit, or workspace policy.
- Pure backend, infrastructure, or non-visual maintenance should not load either guidance skill.
- Ordinary authoring must not load review, execution, decomposition, examples, or semantic-schema guidance unless the request actually needs them.
- When multiple specialists apply, keep each concern with its owner instead of copying the same rule into several files.
- Master skills define policy. Compatibility documents and examples are non-authoritative.
- Keep portable task metadata repository-relative and avoid machine-specific local paths.
- If live tool structure conflicts with prose, follow the live tool structure and update the stale guidance.
- In DevFlow context, visual-product requests such as `preview UI`, `UI preview`, `mockup`, `mock up`, `concept`, `วาด concept`, `ลองทำหน้า...`, `ทำให้ดู`, redesign, or layout stay in DevFlow and route to real repository work plus DevFlow preview/evidence when applicable.
- Image generation is explicit opt-in only when the user clearly asks to generate or create an image, for example `เจนภาพ`, `ทำรูป`, `เจนรูป`, or `generate image`; `mockup` or `concept` alone is not image-generation intent.
