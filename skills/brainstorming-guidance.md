# Brainstorming Guidance

## Metadata
- Id: `brainstorming-guidance`
- Name: Brainstorming Guidance
- Kind: `guidance`
- Description: Turn an idea or behavior change into an appropriately sized, explicitly approved design before implementation.
- Source: https://github.com/obra/superpowers/tree/main/skills/brainstorming
- Source snapshot: 2026-08-13

## Purpose
Use this guidance when a request needs exploration or design before implementation. Keep the process proportional to the uncertainty and impact of the work.

## 1. Classify the work
Choose the smallest path that fits:

- **Spike** — the main need is learning. Define the question, inspect enough evidence to answer it, and return findings or a recommendation. Do not manufacture a full design when the useful output is discovery.
- **Bounded** — the goal and affected area are clear enough to design in a short conversation. Keep the design in chat unless the scope grows materially.
- **Architectural** — the change crosses important boundaries, creates durable contracts, carries migration or rollout risk, or needs decisions that future work will depend on. Capture the approved design in a written specification.

Reclassify if new evidence changes the real scope.

## 2. Inspect context before asking
Review the available conversation, requirement, repository, product, and design context first. Do not ask for information that is already available or that can be established from existing evidence.

Identify the actual unknowns that could change the design. Ignore questions that only add detail without changing a decision.

## 3. Ask one material question at a time
When clarification is necessary, ask a single question that resolves the most important uncertainty. After the answer, update the design picture before deciding whether another question is needed.

Prefer concrete choices when they help the user answer quickly, but do not force false either/or choices when the design space is genuinely broader.

## 4. Offer alternatives with trade-offs
For a real design choice, present two or three viable approaches. Explain the meaningful trade-offs, such as complexity, user experience, compatibility, risk, maintenance cost, or future flexibility.

Recommend one approach and explain why it best fits the stated constraints. Do not present arbitrary options merely to reach a fixed count.

## 5. Present the design at the right depth
A useful design states the decisions another person would need in order to implement the work without guessing. Cover only the dimensions that matter to the scope, for example:

- behavior and user-visible outcomes;
- boundaries, responsibilities, and data flow;
- important states, errors, and edge cases;
- compatibility, migration, or rollout concerns;
- what is explicitly out of scope.

For **Spike** work, findings and a recommended next decision may be enough. For **Bounded** work, a compact in-chat design is preferred. For **Architectural** work, use a durable written specification that records the approved decisions and consequences.

## 6. Require explicit approval
Do not move from design into implementation until the user explicitly approves the proposed direction. Approval should apply to the current design, not to an earlier version that has materially changed.

If the user rejects or changes part of the design, update the affected decisions and seek approval again for the revised direction.

## Completion check
Before treating brainstorming as complete, confirm that:

- the work is classified as Spike, Bounded, or Architectural;
- available context was inspected before clarification;
- unresolved material questions were handled one at a time;
- meaningful alternatives and trade-offs were considered where a real choice existed;
- the design depth matches the scope;
- bounded work remains lightweight while architectural decisions are durable;
- the user explicitly approved the current direction before implementation begins.
