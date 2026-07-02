import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatGptStarterPrompt } from '../../src/lib/chatGptStarterPrompt.js';

test('buildChatGptStarterPrompt tells ChatGPT to read authoring skills before repo context', () => {
  const prompt = buildChatGptStarterPrompt();

  assert.match(prompt, /get_authoring_skills/);
  assert.match(prompt, /00-skill-router/);
  assert.match(prompt, /get_repo_context_bundle/);
  assert.match(prompt, /get_project_start_context/);
  assert.match(prompt, /list_projects/);
  assert.match(prompt, /list_local_files/);
  assert.match(prompt, /read_local_file/);
  assert.match(prompt, /read_file_snippets_batch/);
  assert.match(prompt, /edit_local_files_batch/);
  assert.match(prompt, /safe_edit_local_file/);
  assert.match(prompt, /write_local_file/);
  assert.match(prompt, /apply_patch/);
  assert.match(prompt, /commit_git_changes/);
  assert.match(prompt, /get_jira_authoring_bundle/);
  assert.match(prompt, /get_repo_inspection_index/);
  assert.match(prompt, /get_project_atlas/);
  assert.match(prompt, /architecture, onboarding, unclear targetFiles, or cross-module questions/);
  assert.match(prompt, /validate_task_quality/);
  assert.match(prompt, /move_task_to_status/);
  assert.ok(prompt.indexOf('get_authoring_skills') < prompt.indexOf('get_repo_context_bundle'));
  assert.ok(prompt.indexOf('get_repo_context_bundle') < prompt.indexOf('get_project_start_context'));
});
