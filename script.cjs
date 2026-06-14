const fs = require('fs');
const filepath = 'C:/Users/tatar/.gemini/antigravity/brain/2977cee2-524e-4894-b7f5-2a093ef3de93/.system_generated/worktrees/subagent-DVF-0155-Writer-self-ea70f6ae/skills/playbook.md';

let content = fs.readFileSync(filepath, 'utf-8');
content = content.replace(/\r\n/g, '\n');

const target1 = `## Agent Drive Workflow

When an agent is being explicitly driven by the user to execute a specific task card, it must strictly follow this lifecycle:

1. **Read Task Content**: Read the task card details carefully, including all checklist items, acceptance criteria, and subtasks (if any).
2. **Move to In Progress**: Before starting the actual work, update the task status and move the card to \`in-progress\`.
3. **Handle Subtasks**: If the task contains subtasks, spawn subagents to help work on them concurrently.
4. **Commit to Branch**: Perform the implementation. When finished, commit the changes to the specific branch designated by the task card (\`branch\` field).
5. **Move to Ready for Review**: Once all implementation and checklist items are verified, move the task card status to \`ready-for-review\` and wait for human feedback.
6. **Merge and Push**: Wait for the user's approval. If the user says "ผ่าน" (Passed) or explicitly approves, merge the branch into \`develop\` and push the changes.
7. **Complete Task**: Finally, update the task card status to \`done\` (Completed).

Do not skip any steps. In particular, always pause at \`ready-for-review\` before merging.`;

const replacement1 = `## Auto Work & Agent Execution Workflow

Dev Flow supports Auto Work, where assigned agents are automatically launched when tasks are moved to the \`todo\` lane.

### For Planning/Prep Agents:
1. **Assign Configuration**: Ensure the task has a valid \`agent\`, \`model\`, and \`effort\` assigned.
2. **Trigger Auto Work**: Move the task to the \`todo\` lane. If Auto Work is enabled, the Dev Flow server will automatically launch the agent. Do not manually move the task to \`in-progress\`.

### For Worker Agents:
When an agent is launched to execute a specific task card, it must strictly follow this lifecycle:

1. **Read Task Content**: Read the task card details carefully from the prompt or task context, including all checklist items, acceptance criteria, and subtasks.
2. **Start Work**: The task is automatically tracked as an active run. (You do not need to manually move it to \`in-progress\` on launch).
3. **Handle Subtasks**: If the task contains subtasks, spawn subagents to help work on them concurrently.
4. **Commit to Branch**: Perform the implementation. When finished, commit the changes to the specific branch designated by the task card (\`branch\` field).
5. **Checklist Verification**: Verify all implementation against the checklist items. Mark verified items as completed using the \`toggle_task_checklist\` MCP tool.
6. **Complete the Run**: Once verified, use the \`complete_agent_run\` MCP tool with status \`success\`. This will close the active run and automatically move the task to \`ready-for-review\` to wait for human feedback.
7. **Merge and Push**: Wait for the user's approval. If the user says "ผ่าน" (Passed) or explicitly approves, merge the branch into \`develop\` and push the changes.
8. **Complete Task**: Finally, update the task card status to \`done\` (Completed).

Do not skip any steps. In particular, always pause at \`ready-for-review\` before merging.`;

if (!content.includes(target1)) {
    console.error('Error: Target 1 not found');
    process.exit(1);
}

content = content.replace(target1, replacement1);

const target2 = `6. Only move the card to \`ready-for-review\` after this checklist verification process is done.`;
const replacement2 = `6. Only close the run (using \`complete_agent_run\`) and move the card to \`ready-for-review\` after this checklist verification process is done.`;

if (!content.includes(target2)) {
    console.error('Error: Target 2 not found');
    process.exit(1);
}

content = content.replace(target2, replacement2);

fs.writeFileSync(filepath, content, 'utf-8');
console.log('Success');
