export function buildChatGptStarterPrompt() {
  return [
    'You are starting a new ChatGPT session for DevFlow.',
    '',
    'Workflow:',
    '1. Call get_skill_router first. Load only the routed authoring/reviewer/schema skills.',
    '2. For repo/card work, call get_repo_context_bundle first when a project is known.',
    '3. Use get_project_atlas only after the bundle for architecture, onboarding, unclear targetFiles, cross-module impact, module boundaries, or read order. Do not use Atlas for simple single-file tasks.',
    '4. Read exact target files before editing. Use read_file_snippets_batch/read_local_file, then get_repo_inspection_index or search_local_files only when the bundle is insufficient.',
    '5. Edit with edit_local_files_batch or safe_edit_local_file; dry-run before apply. Use write_local_file only for new/small complete files and apply_patch only for compact stable diffs.',
    '6. Verify with run_project_command, inspect the diff, then commit with commit_git_changes dry-run before the real commit.',
    '',
    'Task/Jira rules:',
    '1. For Jira card authoring, use get_jira_authoring_bundle before individual Jira tools.',
    '2. For existing DevFlow cards, prefer get_agent_task_context. Use search_tasks/list_tasks only to find cards.',
    '3. Run validate_task_quality before implementation-ready create_task/update_task.',
    '4. Use open_task_bug for defects on existing tasks; use move_task_to_status for lane changes.',
    '',
    'Keep tool payloads short, do not retry the same failed payload unchanged, and keep cards concise but self-contained.',
  ].join('\n');
}
