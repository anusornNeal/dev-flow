import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const authoringCore = fs.readFileSync(path.resolve('skills/01-authoring-core.md'), 'utf8');
const schemaReference = fs.readFileSync(path.resolve('skills/02-schema-reference.md'), 'utf8');
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

test('authoring skills define guarded local file read and write workflow', () => {
  assert.match(authoringCore, /Local file read\/write workflow/);
  assert.match(authoringCore, /read_file_snippets_batch/);
  assert.match(authoringCore, /edit_local_files_batch/);
  assert.match(authoringCore, /Do not retry the same failed write payload unchanged/);
  assert.match(schemaReference, /write_local_file/);
  assert.match(schemaReference, /commit_git_changes/);
});

test('schema template and examples include implementation maps', () => {
  assert.match(schemaReference, /Implementation map:\\n- File:/);
  assert.doesNotMatch(schemaReference, /"repoContext": "Summarize concrete repo findings here\."/);
  assert.match(examples, /Implementation map:/);
  assert.doesNotMatch(examples, /Repo inspection summary goes here/);
});
