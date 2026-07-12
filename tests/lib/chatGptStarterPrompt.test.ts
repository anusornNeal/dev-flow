import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatGptStarterPrompt } from '../../src/lib/chatGptStarterPrompt.js';

test('buildChatGptStarterPrompt routes ChatGPT into skills without duplicating detailed tool rules', () => {
  const prompt = buildChatGptStarterPrompt();

  assert.match(prompt, /get_skill_router/);
  assert.match(prompt, /00-skill-router/);
  assert.match(prompt, /get_authoring_skill/);
  assert.match(prompt, /get_skill/);
  assert.match(prompt, /source of truth/);
  assert.match(prompt, /load only the skills routed/);
  assert.match(prompt, /action type changes/);
  assert.doesNotMatch(prompt, /get_repo_context_bundle/);
  assert.doesNotMatch(prompt, /get_project_atlas/);
  assert.doesNotMatch(prompt, /edit_local_files_batch/);
  assert.doesNotMatch(prompt, /get_jira_authoring_bundle/);
  assert.ok(prompt.indexOf('get_skill_router') < prompt.indexOf('get_authoring_skill'));
  assert.ok(prompt.length < 1200);
  assert.ok(prompt.split('\n').length <= 11);
});
