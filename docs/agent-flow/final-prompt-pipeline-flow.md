# Final Prompt Pipeline and Fresh-Session Flow

## Prompt Pipeline (`config/prompt-pipeline.json`)
DevFlow implements a strict sequential prompt pipeline to guarantee deterministic context for every agent.
The pipeline resolves skills from the `skills/` directory.

### Pipeline Stages
1. **Header**: Provides Task ID, Title, Project, and explicit assignment configuration.
2. **Task Context**: Contains the core definition: Description, Acceptance Criteria, Verification, and target files.
3. **Repo Context**: Explains the codebase, DevFlow MCP, and workspace rules.
4. **Checklist & Subtasks**: Explains minitasks the agent must accomplish.
5. **Execution Rules**: Strict rules restricting the agent from bypassing DevFlow's orchestration (e.g. "Do not loop after this task").
6. **Agent Specific**: Injects any tool or capability constraints specific to the chosen agent (`{agent}` variable).
7. **Completion Contract**: Instructs the agent exactly how to signal completion and stop its session.
8. **Footer**: Final enforcing statements.

### Enforcement
- DevFlow parses this pipeline and fails fast if any standard skill is missing, ensuring a broken configuration prevents an agent launch.

## Fresh-Session Orchestration
Agents must not perform multiple tasks per session. DevFlow strictly enforces this through:
1. **Runner Wrapper (`launch.bat`)**: The `runner.ts` generates a distinct wrapper script for every spawned agent.
2. **Auto-Completion Reporting**: The agent script does NOT poll for task completion. The wrapper monitors the agent process itself. Upon process exit, `launch.bat` uses PowerShell to explicitly `POST` the completion status webhook to DevFlow before the window closes.
3. **Queue Skipping**: If an agent fails to launch, or if prompt building fails, DevFlow automatically reverts the stale card to `todo` and proceeds to the next valid card.
4. **Startup Sanitization**: Any cards left in an `in-progress` state without an active local run when DevFlow boots are immediately reverted to `todo` to prevent deadlocks.
