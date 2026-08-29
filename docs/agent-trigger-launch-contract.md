# Legacy Agent Trigger Contract — Retired

The fresh-process agent launcher is retired. DevFlow no longer starts agent CLIs through Auto Work, `src/runner.ts`, `scripts/trigger-agent.bat`, launcher configuration, generated `.devflow/runs` files, retry/cancel callbacks, or execution-mode settings.

## Supported execution paths

- **Managed execution sessions** own claim, workspace, verification, autonomous-tail, finalization, recovery, and terminal status.
- **External worker synchronization** can project replaceable worker presence/result metadata without impersonating managed lifecycle authority.
- **Historical `agent_runs` rows and run files** remain read-only cold compatibility data for audit/history endpoints. This retirement does not delete the `agent_runs` table or existing `.devflow/runs/<runId>` artifacts.

## Compatibility boundary

Legacy persisted settings such as `agentExecutionMode` and `autoWork` may remain in existing databases, but active Settings APIs/UI ignore them. Legacy run history can be read, but production code must not create, retry, cancel, complete, mutate, or launch a legacy agent run.

`src/runner.ts` and `scripts/trigger-agent.bat` are fail-closed compatibility entry points: invoking them reports that the launcher is retired and exits without spawning an agent process.
