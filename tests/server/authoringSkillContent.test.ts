import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (name: string) => fs.readFileSync(path.resolve('skills', name), 'utf8');
const skillRouter = read('00-skill-router.md');
const authoringCore = read('01-authoring-core.md');
const schemaReference = read('02-schema-reference.md');
const reviewerCore = read('03-reviewer-core.md');
const examples = read('04-examples.md');
const evidenceSkill = read('05-authoring-evidence.md');
const decompositionSkill = read('06-authoring-decomposition.md');
const executionSkill = read('07-authoring-execution.md');
const executionRules = read('prompt.execution-rules.md');

test('common authoring static guidance is lean and schema shapes stay live', () => {
  const commonBytes = Buffer.byteLength(skillRouter) + Buffer.byteLength(authoringCore);
  assert.equal(commonBytes <= 15_000, true, `common authoring guidance should stay <=15KB, got ${commonBytes}`);
  assert.equal(Buffer.byteLength(schemaReference) <= 5_000, true);
  assert.match(schemaReference, /live (task|tool).*schema/i);
  assert.doesNotMatch(schemaReference, /^### status$/m);
  assert.doesNotMatch(schemaReference, /^### model$/m);
});

test('lean core keeps semantic implementation-ready rules', () => {
  assert.match(authoringCore, /Bounded repo inspection/);
  assert.match(authoringCore, /Implementation map/);
  assert.match(authoringCore, /Do not scan or read the whole repo/);
  assert.match(authoringCore, /Delta rule/);
  assert.match(authoringCore, /observable/i);
  assert.match(authoringCore, /Default card status is `backlog`/);
  assert.doesNotMatch(authoringCore, /get_jira_authoring_bundle/);
  assert.doesNotMatch(authoringCore, /prepare_compact_edit/);
});

test('source-specific evidence is loaded on demand', () => {
  assert.match(evidenceSkill, /get_jira_authoring_bundle/);
  assert.match(evidenceSkill, /Figma evidence/);
  assert.match(evidenceSkill, /get_figma_authoring_context/);
  assert.match(evidenceSkill, /attach_figma_context_to_task/);
  assert.match(evidenceSkill, /Project Atlas/);
  assert.match(evidenceSkill, /get_project_atlas/);
  assert.match(skillRouter, /05-authoring-evidence/);
});

test('decomposition guidance is isolated from the common core', () => {
  assert.match(decompositionSkill, /Subtask-first decomposition/);
  assert.match(decompositionSkill, /Do not hide real subtask work inside a long checklist/);
  assert.match(decompositionSkill, /Frontend\/backend split/);
  assert.match(decompositionSkill, /Create separate cards when/);
  assert.match(skillRouter, /06-authoring-decomposition/);
});

test('repo execution guidance is load-on-demand and keeps guarded edit rules', () => {
  assert.match(executionSkill, /Local file read\/write workflow/);
  assert.match(executionSkill, /read_file_snippets_batch\(includeFileRef=true\)/);
  assert.match(executionSkill, /prepare_compact_edit/);
  assert.match(executionSkill, /apply_prepared_edit/);
  assert.match(executionSkill, /apply_and_verify/);
  assert.match(executionSkill, /Do not retry the same failed write payload unchanged/);
  assert.match(executionSkill, /FAST/);
  assert.match(executionSkill, /SAFE/);
  assert.match(executionSkill, /FULL/);
  assert.match(skillRouter, /07-authoring-execution/);
  assert.match(executionRules, /apply_and_verify/);
});

test('DevFlow edit policy defaults LLM-authored existing-file changes to Steno', () => {
  assert.equal(skillRouter.includes('LLM-authored existing-file'), true);
  assert.equal(skillRouter.includes('trusted native Git unified diff'), true);
  assert.equal(authoringCore.includes('do not synthesize native unified diffs'), true);
  assert.equal(authoringCore.includes('tiny anchored single-file edit'), true);
  assert.equal(authoringCore.includes('already-existing or trusted native Git unified diff'), true);
  assert.equal(schemaReference.includes('LLM-authored existing-file'), true);
  assert.equal(schemaReference.includes('*** Begin Patch'), true);
  assert.equal(executionRules.includes('LLM-authored existing-file'), true);
  assert.equal(executionRules.includes('trusted native Git unified diff'), true);
});

test('authoring skills route existing task defects to embedded bug threads', () => {
  assert.match(skillRouter, /open_task_bug/);
  assert.match(authoringCore, /Embedded bug thread rule/);
  assert.match(authoringCore, /Do not use `create_task`/);
  assert.match(schemaReference, /open_task_bug/);
});
test('reviewer and examples keep embedded bug-thread routing visible', () => {
  assert.match(reviewerCore, /open_task_bug/);
  assert.match(skillRouter, /03-reviewer-core/);
  assert.match(skillRouter, /open_task_bug/);
  assert.match(examples, /Embedded task bug thread/);
});

test('schema semantic fallback still explains implementation-map placement', () => {
  assert.match(schemaReference, /Implementation map/);
  assert.match(schemaReference, /targetFiles/);
  assert.match(schemaReference, /repoContext/);
  assert.match(schemaReference, /acceptanceCriteria/);
  assert.match(schemaReference, /verification/);
});
