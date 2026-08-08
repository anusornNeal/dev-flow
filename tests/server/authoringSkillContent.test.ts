import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const authoringCore = fs.readFileSync(path.resolve('skills/01-authoring-core.md'), 'utf8');
const schemaReference = fs.readFileSync(path.resolve('skills/02-schema-reference.md'), 'utf8');
const skillRouter = fs.readFileSync(path.resolve('skills/00-skill-router.md'), 'utf8');
const reviewerCore = fs.readFileSync(path.resolve('skills/03-reviewer-core.md'), 'utf8');
const executionRules = fs.readFileSync(path.resolve('skills/prompt.execution-rules.md'), 'utf8');
const examples = fs.readFileSync(path.resolve('skills/04-examples.md'), 'utf8');

test('authoring core requires targeted repo inspection and implementation maps', () => {
  assert.match(authoringCore, /Bounded repo inspection/);
  assert.match(authoringCore, /Implementation map/);
  assert.match(authoringCore, /classes, composables, functions, methods, helpers, routes, mappers, or tests/);
  assert.match(authoringCore, /Do not scan or read the whole repo/);
});

test('authoring skills require Jira bundle first and frontend/backend split decisions', () => {
  assert.ok(authoringCore.indexOf('get_jira_authoring_bundle') < authoringCore.indexOf('Read individual Jira'));
  assert.match(authoringCore, /Frontend\/backend split rule/);
  assert.match(authoringCore, /Create separate cards when/);
  assert.match(authoringCore, /Keep one general card only when/);
});

test('authoring skills default to backlog and prefer parent child decomposition', () => {
  assert.match(authoringCore, /Subtask-first decomposition rule/);
  assert.match(authoringCore, /Do not hide real subtask work inside a long checklist/);
  assert.match(authoringCore, /keep every parent and child in `backlog` by default/);
  assert.match(authoringCore, /Default card status is `backlog`/);
  assert.match(authoringCore, /Do not set `todo` merely because the card is well specified/);
  assert.match(schemaReference, /Do not infer `todo` from implementation readiness alone/);
});

test('examples show bad oversized card versus backlog parent child split', () => {
  assert.match(examples, /Bad vs good split example/);
  assert.match(examples, /one oversized implementation card hides independent work/);
  assert.match(examples, /The checklist is doing the job that child cards should do/);
  assert.match(examples, /Good: create a backlog parent plus focused backlog children/);
});

test('authoring skills define guarded local file read and write workflow', () => {
  assert.match(authoringCore, /Local file read\/write workflow/);
  assert.match(authoringCore, /read_file_snippets_batch/);
  assert.match(authoringCore, /edit_local_files_batch/);
  assert.match(authoringCore, /Do not retry the same failed write payload unchanged/);
  assert.match(schemaReference, /write_local_file/);
  assert.match(schemaReference, /commit_git_changes/);
});

test('execution guidance batches multi-file Steno bootstrap reads', () => {
  assert.match(skillRouter, /read_file_snippets_batch\(includeFileRef=true\)/);
  assert.match(schemaReference, /read_file_snippets_batch\(includeFileRef=true\)/);
  assert.match(executionRules, /read_file_snippets_batch\(includeFileRef=true\)/);
  assert.match(executionRules, /single-file/i);
});

test('schema template and examples include implementation maps', () => {
  assert.match(schemaReference, /Implementation map:\\n- File:/);
  assert.doesNotMatch(schemaReference, /"repoContext": "Summarize concrete repo findings here\."/);
  assert.match(examples, /Implementation map:/);
  assert.doesNotMatch(examples, /Repo inspection summary goes here/);
});

test('authoring skills describe Atlas as selective companion context', () => {
  assert.match(skillRouter, /get_project_atlas/);
  assert.match(skillRouter, /Do not require Project Atlas for simple single-file/);
  assert.match(authoringCore, /Use `get_project_atlas` as a companion, not a replacement/);
  assert.match(authoringCore, /verified Atlas facts/);
  assert.match(authoringCore, /do not override them silently/);
  assert.match(schemaReference, /modes `compact`, `standard`, `agent-context`, `chatgpt-context`, `task-focused`, or `diff-impact`/);
  assert.match(reviewerCore, /target files, implementation maps, module boundaries/);
  assert.match(reviewerCore, /module boundaries/);
  assert.match(examples, /Atlas-assisted card/);
});

test('DevFlow execution guidance prefers Steno and smart verification lanes', () => {
  assert.match(skillRouter, /prepare_compact_edit/);
  assert.match(skillRouter, /apply_prepared_edit/);
  assert.match(skillRouter, /apply_and_verify/);
  assert.match(skillRouter, /repo-relative paths/);
  assert.match(skillRouter, /absolute local repo paths/);
  assert.match(authoringCore, /smart verification/i);
  assert.match(executionRules, /apply_and_verify/);
  assert.match(executionRules, /FAST/);
  assert.match(executionRules, /SAFE/);
  assert.match(executionRules, /FULL/);
  assert.match(executionRules, /forceFresh/);
});

test('authoring skills route existing task defects to embedded bug threads', () => {
  assert.match(skillRouter, /open_task_bug/);
  assert.match(authoringCore, /Embedded bug thread rule/);
  assert.match(authoringCore, /Do not use `create_task`/);
  assert.match(schemaReference, /open_task_bug/);
  assert.match(reviewerCore, /open_task_bug/);
  assert.match(examples, /Embedded task bug thread/);
});
