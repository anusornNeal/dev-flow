# DevFlow Guidance Skills Design

Date: 2026-08-13
Status: Draft for user review

## Goal

Add two lightweight guidance skills to DevFlow so ChatGPT can retrieve design and brainstorming principles directly from DevFlow when relevant:

- `brainstorming-guidance`
- `ui-ux-guidance`

These are guidance-only skills. They are not full ports of the upstream runtimes.

## Scope

### Included

- Distilled principles and decision rules from the upstream skills.
- DevFlow registry metadata and on-demand prompt routing.
- ChatGPT/DevFlow-neutral wording.
- Clear separation between process guidance and UI/UX domain guidance.
- Source provenance in the skill metadata or documentation.

### Excluded

- UI/UX Pro Max Python search engine.
- CSV design databases, templates, CLI installers, or generated design-system files.
- Upstream agent-specific paths such as `.claude/skills` and `CLAUDE_PLUGIN_ROOT`.
- Runtime commands that require Python, Node, or external packages.
- Automatic image generation.
- Copying DevFlow execution, commit, or verification policy into either guidance skill.

## Skill 1: brainstorming-guidance

The skill provides a compact process for turning an idea into an approved design before implementation.

It should guide ChatGPT to:

1. Classify the request as Spike, Bounded, or Architectural.
2. Inspect the available project and conversation context before asking questions.
3. Ask only one material clarification question at a time.
4. Propose two or three approaches with trade-offs and a recommendation.
5. Present the design at a depth appropriate to the scope.
6. Wait for explicit user approval before implementation.
7. Keep small bounded designs in chat; use a written design spec only for architectural work.

The skill must not require a specific coding-agent CLI, filesystem path, external skill invocation, or repository workflow.

## Skill 2: ui-ux-guidance

The skill provides design principles for UI-related work without requiring the upstream search database.

It should guide ChatGPT to:

1. Use the skill when a request changes visual structure, layout, interaction, navigation, accessibility, animation, or data presentation.
2. Inspect the existing UI patterns and detect the actual platform/stack before making recommendations.
3. Establish a coherent design direction for new screens before implementation.
4. Consider hierarchy, spacing, density, typography, color, component states, feedback, responsive behavior, accessibility, and interaction quality.
5. Preserve existing product patterns unless the requirement explicitly changes them.
6. Explain important design choices and trade-offs instead of presenting arbitrary styling.
7. Use DevFlow UI Preview when visual evidence is needed; do not substitute generated images for a product UI preview.

The skill should remain framework-neutral while allowing stack-specific recommendations when the repository context identifies the stack.

## Routing and precedence

- Creative feature or behavior change: load brainstorming guidance first.
- UI, screen, layout, interaction, or visual review: load ui-ux guidance.
- A new UI feature: use both, with brainstorming controlling the design-approval process and ui-ux guidance controlling visual/interaction quality.
- Pure backend, infrastructure, or non-visual maintenance: do not load either guidance skill.
- DevFlow's execution and verification skills remain authoritative for implementation, tests, commits, and workspace lifecycle.

Both guidance skills should be loaded on demand. They should not be appended to every prompt.

## Storage model

Register them as guidance skills in a namespace separate from DevFlow's protected master authoring and execution skills. The existing master router should only route to them when the request matches their purpose; it should not duplicate their full content.

Each skill entry should include:

- stable id
- display name
- short description
- source URL
- source snapshot/version date
- distilled content
- guidance kind/namespace

## Verification

The implementation should prove that:

- Both guidance skills are discoverable from DevFlow.
- Their content can be retrieved by ChatGPT through the existing skill surface.
- A UI feature request can retrieve brainstorming guidance and ui-ux guidance in the intended order.
- A pure backend request does not automatically load either guidance skill.
- The guidance content contains no required upstream runtime command or platform-specific path.
- Existing DevFlow master skill routing and prompt behavior remain unchanged for unrelated requests.
- The two skills remain concise enough that on-demand loading does not create unnecessary prompt bloat.

## Parallel implementation boundary

The work can be split into independent slices:

1. Add and validate the brainstorming guidance content.
2. Add and validate the ui-ux guidance content.
3. Wire both entries into registry/router/prompt retrieval after the content contracts are agreed.

The first two slices can run in parallel. The routing slice depends only on their stable ids and metadata.

## Source provenance

- UI/UX Pro Max: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- Brainstorming: https://github.com/obra/superpowers/tree/main/skills/brainstorming

This design intentionally preserves the useful concepts from the sources while adapting away implementation details that are specific to their original agent environments.
