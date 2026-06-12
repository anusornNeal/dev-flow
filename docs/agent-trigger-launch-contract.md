# Agent Trigger Launch Contract

DevFlow resolves agent launches through one deterministic path before creating an active run:

1. A task becomes eligible for Auto Work when it is in `todo`, Auto Work is enabled, and it has an assigned agent.
2. The selected agent/model/effort is validated against `config/agents/<agent>.json`.
3. Invalid agent/model combinations are rejected before an `agent_runs` row is created.
4. The prompt file is written to `.devflow/runs/<runId>/prompt.md` with launch metadata at the top.
5. `scripts/trigger-agent.bat` invokes `src/runner.ts` with short file/path references, not the full prompt body.
6. The runner resolves the executable, maps the DevFlow model label to the CLI model id, and builds argv.
7. Reasoning effort is emitted only through a verified configured CLI flag. Otherwise it is prompt-only metadata.
8. Codex writes `.devflow/runs/<runId>/launch.bat` and starts a visible Windows terminal using that script.
9. The server marks the run `running` only after `trigger-agent.bat` exits successfully. Spawn or validation failures mark it `failed`.
10. Stale active runs are cancelled before new busy checks, and moving a task to `ready-for-review` or `done` settles the active run.

Relevant files:

- `src/server/routes/tasks.ts`
- `src/server/services/taskService.ts`
- `src/server/services/agentRunService.ts`
- `src/server/repositories/agentRunRepository.ts`
- `src/lib/agentsConfig.ts`
- `src/runner.ts`
- `scripts/trigger-agent.bat`
- `config/agents/*.json`
