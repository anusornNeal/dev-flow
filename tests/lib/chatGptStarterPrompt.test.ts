import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatGptStarterPrompt } from '../../src/lib/chatGptStarterPrompt.js';

test('buildChatGptStarterPrompt tells ChatGPT to read authoring skills before repo context', () => {
  const prompt = buildChatGptStarterPrompt();

  assert.match(prompt, /get_authoring_skills/);
  assert.match(prompt, /00-skill-router/);
  assert.match(prompt, /list_projects/);
  assert.match(prompt, /list_local_files/);
  assert.match(prompt, /read_local_file/);
  assert.match(prompt, /get_repo_inspection_index/);
  assert.match(prompt, /validate_task_quality/);
  assert.ok(prompt.indexOf('get_authoring_skills') < prompt.indexOf('list_projects'));
});
