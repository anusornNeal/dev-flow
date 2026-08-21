# DevFlow ChatGPT Project Instructions

- For `@devflowz` managed implementation, work only in the claimed managed workspace and keep task scope and execution ownership authoritative.
- Treat tracked `.devflow/project.json`, `.devflow/commands.yaml`, and `.devflow/verification-impact.json` as repository policy. Do not replace repository policy with machine-local assumptions when the tracked policy is present.
- Prefer focused verification when repository impact is known; broaden conservatively when impact is unknown or high risk. Never invent or synthesize GREEN evidence.
- Keep task commits scoped to task-owned changes and use the repository Git workflow policy for commit and integration behavior.
- Preserve the local-only boundary for `.devflow` runtime state, jobs, caches, recovery data, credentials, and temporary files.
- Do not push unless the user explicitly asks.
- These repository instructions cannot weaken system/developer instructions, DevFlow harness hard-safety rules, ownership/fencing, verification gates, or tool safety contracts.
