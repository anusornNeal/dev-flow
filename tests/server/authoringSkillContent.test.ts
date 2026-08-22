import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (name: string) => fs.readFileSync(path.resolve('skills', name), 'utf8');
const source = (name: string) => fs.readFileSync(path.resolve(name), 'utf8');
const occurrences = (content: string, value: string) => content.split(value).length - 1;

const skillRouter = read('00-skill-router.md');
const authoringCore = read('01-authoring-core.md');
const schemaReference = read('02-schema-reference.md');
const reviewerCore = read('03-reviewer-core.md');
const examples = read('04-examples.md');
const evidenceSkill = read('05-authoring-evidence.md');
const decompositionSkill = read('06-authoring-decomposition.md');
const executionSkill = read('07-authoring-execution.md');
const boardLoopSkill = read('08-board-loop-execution.md');
const executionRules = read('prompt.execution-rules.md');
const legacyReviewer = read('ready-for-review-reviewer-skill.md');
const legacySchema = read('schema.md');
const skillsRepository = source('src/server/repositories/skillsRepository.ts');

test('router is one short routing-only decision flow', () => {
  assert.equal(Buffer.byteLength(skillRouter) <= 4_500, true, `router should stay <=4.5KB, got ${Buffer.byteLength(skillRouter)}`);
  for (const id of [
    '01-authoring-core',
    '02-schema-reference',
    '03-reviewer-core',
    '04-examples',
    '05-authoring-evidence',
    '06-authoring-decomposition',
    '07-authoring-execution',
    '08-board-loop-execution',
  ]) {
    assert.equal(occurrences(skillRouter, id), 1, `${id} should appear exactly once in the router`);
  }
  for (const executionDetail of [
    'prepare_compact_edit',
    'apply_prepared_edit',
    'read_file_snippets_batch',
    'commit_task_owned_changes',
    'finalize_task_workspace',
    'TASK_SCOPE_CONFLICT',
    'RED-required',
  ]) {
    assert.doesNotMatch(skillRouter, new RegExp(executionDetail), `router must not own ${executionDetail} policy`);
  }
  assert.match(skillRouter, /get_tool_schema/);
});

test('01 owns common authoring while 02 owns only semantic field placement', () => {
  assert.match(authoringCore, /Bounded repo inspection/);
  assert.match(authoringCore, /Implementation map/);
  assert.match(authoringCore, /Do not scan or read the whole repo/);
  assert.match(authoringCore, /Delta rule/);
  assert.match(authoringCore, /observable/i);
  assert.match(authoringCore, /Default card status is `backlog`/);
  for (const specialistToken of [
    'prepare_compact_edit',
    'edit_local_files_batch',
    'apply_and_verify',
    'commit_task_owned_changes',
    'finalize_task_workspace',
    'open_task_bug',
    'get_jira_authoring_bundle',
    'get_figma_authoring_context',
    'get_project_atlas',
  ]) {
    assert.doesNotMatch(authoringCore, new RegExp(specialistToken), `01 must not own ${specialistToken}`);
  }

  assert.equal(Buffer.byteLength(schemaReference) <= 4_000, true);
  assert.match(schemaReference, /get_tool_schema/);
  assert.match(schemaReference, /Implementation map/);
  assert.match(schemaReference, /repoContext/);
  assert.match(schemaReference, /targetFiles/);
  assert.match(schemaReference, /acceptanceCriteria/);
  assert.match(schemaReference, /verification/);
  for (const executionToken of [
    'prepare_compact_edit',
    'apply_prepared_edit',
    'edit_local_files_batch',
    'apply_and_verify',
    'commit_git_changes',
    'move_task_to_status',
  ]) {
    assert.doesNotMatch(schemaReference, new RegExp(executionToken), `02 must not duplicate ${executionToken}`);
  }
  assert.doesNotMatch(schemaReference, /^### status$/m);
  assert.doesNotMatch(schemaReference, /^### model$/m);
});

test('03 is the canonical reviewer and the legacy reviewer is only a compatibility pointer', () => {
  assert.match(reviewerCore, /ready-for-review/i);
  assert.match(reviewerCore, /open_task_bug/);
  assert.match(reviewerCore, /Latest explicit user|latest explicit user/i);
  assert.match(reviewerCore, /repository implementation|implementation evidence/i);

  assert.equal(Buffer.byteLength(legacyReviewer) <= 2_000, true, `legacy reviewer should be a thin pointer, got ${Buffer.byteLength(legacyReviewer)}`);
  assert.match(legacyReviewer, /compatibility/i);
  assert.match(legacyReviewer, /03-reviewer-core/);
  assert.match(legacyReviewer, /non-authoritative|not authoritative/i);
  assert.doesNotMatch(legacyReviewer, /^## Pass Criteria$/m);
  assert.doesNotMatch(legacyReviewer, /^## Fail Criteria$/m);
});

test('05 separates desired requirement authority from implementation evidence', () => {
  assert.match(evidenceSkill, /get_jira_authoring_bundle/);
  assert.match(evidenceSkill, /get_figma_authoring_context/);
  assert.match(evidenceSkill, /attach_figma_context_to_task/);
  assert.match(evidenceSkill, /get_project_atlas/);
  assert.match(evidenceSkill, /Desired requirement authority/i);
  assert.match(evidenceSkill, /Implementation evidence/i);
  assert.match(evidenceSkill, /repository.*cannot.*override.*requirement|current code.*does not override/i);
  assert.doesNotMatch(evidenceSkill, /current repository behavior > current source evidence/i);
});

test('04 stays examples-only, compact, and free of retired Atlas UI examples', () => {
  assert.equal(Buffer.byteLength(examples) <= 9_000, true, `examples should stay <=9KB, got ${Buffer.byteLength(examples)}`);
  assert.match(examples, /example/i);
  assert.doesNotMatch(examples, /ProjectAtlasPage|AtlasGraph|Project Atlas controls/i);
  assert.doesNotMatch(examples, /^## (Policy|Rules|Required workflow)/mi);
});

test('06 preserves parallel children and explicit prerequisite direction', () => {
  assert.match(decompositionSkill, /Subtask-first decomposition/);
  assert.match(decompositionSkill, /parallel/i);
  assert.match(decompositionSkill, /prerequisite/i);
  assert.match(decompositionSkill, /Do not hide real subtask work inside a long checklist/);
  assert.match(decompositionSkill, /Frontend\/backend split/);
});

test('07 owns implementation, verification, task workspace lifecycle, and terminal recovery', () => {
  for (const token of [
    'claim_task',
    'managed workspace',
    'read_file_snippets_batch(includeFileRef=true)',
    'prepare_compact_edit',
    'apply_prepared_edit',
    'apply_and_verify',
    'plan_task_commit',
    'commit_task_owned_changes',
    'finalize_task_workspace',
    'inspect_workspace_recovery',
    'get_tool_job_result',
  ]) {
    assert.match(executionSkill, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `07 should own ${token}`);
  }
  assert.match(executionSkill, /UNDERSTAND\/DESIGN[\s\S]*IMPLEMENT[\s\S]*VERIFY/i);
  assert.match(executionSkill, /contract[\s\S]*boundar(?:y|ies)[\s\S]*edge cases/i);
  assert.match(executionSkill, /bug[\s\S]*(?:reproduc|defect evidence)/i);
  assert.match(executionSkill, /existing failing test|focused test/i);
  assert.match(executionSkill, /deterministic command|deterministic scenario/i);
  assert.match(executionSkill, /runtime.*log|log.*evidence/i);
  assert.match(executionSkill, /impractical|unsafe|nondeterministic|no independent information/i);
  assert.match(executionSkill, /no intermediate|do not run[^\n]*intermediate/i);
  assert.match(executionSkill, /one frozen candidate|same frozen candidate/i);
  assert.match(executionSkill, /parallel[\s\S]*(?:final verification|verification batch)|(?:final verification|verification batch)[\s\S]*parallel/i);
  assert.match(executionSkill, /do not mutate[\s\S]*(?:final verification|verification batch)|(?:final verification|verification batch)[\s\S]*do not mutate/i);
  assert.match(executionSkill, /join[\s\S]*required|all required[\s\S]*join/i);
  assert.match(executionSkill, /another revision[\s\S]*invalid|other revision[\s\S]*invalid|evidence[\s\S]*same frozen candidate/i);
  assert.match(executionSkill, /FAST[\s\S]*SAFE[\s\S]*FULL/i);
  assert.match(executionSkill, /FULL[\s\S]*(?:not the normal leaf|parent|integration|milestone)/i);
  assert.doesNotMatch(executionSkill, /exactly two logical verification phases/i);
  assert.doesNotMatch(executionSkill, /Two-pass verification \(test-first\)/i);
  assert.doesNotMatch(executionSkill, /testable behavior changes[\s\S]{0,160}RED/i);
  assert.match(executionSkill, /prefer `finalize_task_workspace`|preferred terminal/i);
  assert.match(executionSkill, /integrate_workspace.*fallback|fallback.*integrate_workspace/i);
  assert.match(executionSkill, /batch[\s\S]*checklist|checklist[\s\S]*batch/i);
  assert.match(executionSkill, /Do not push/i);
});

test('08 owns only board orchestration and delegates implementation policy to 07', () => {
  assert.match(boardLoopSkill, /claim_next_task/);
  assert.match(boardLoopSkill, /claim_task/);
  assert.match(boardLoopSkill, /status=backlog[\s\S]*status=todo/i);
  assert.match(boardLoopSkill, /mode=minimal[\s\S]*mode=summary|mode=summary[\s\S]*mode=minimal/i);
  assert.match(boardLoopSkill, /unfiltered[\s\S]*(?:ordinary )?next-work selection/i);
  assert.match(boardLoopSkill, /backlog-only[\s\S]*never proof/i);
  assert.match(boardLoopSkill, /Completed tasks may still be read/i);
  assert.match(boardLoopSkill, /parent\/child completion[\s\S]*review or audit[\s\S]*history/i);
  assert.match(boardLoopSkill, /known by id[\s\S]*get_task/i);

  assert.match(boardLoopSkill, /TASK_ALREADY_CLAIMED/);
  assert.match(boardLoopSkill, /TASK_SCOPE_CONFLICT/);
  assert.match(boardLoopSkill, /finalize_task_workspace/);
  assert.match(boardLoopSkill, /needs-recovery/);
  assert.match(boardLoopSkill, /07-authoring-execution/);
  assert.match(boardLoopSkill, /parallel/i);
  assert.match(boardLoopSkill, /repeat|loop/i);
  assert.match(boardLoopSkill, /Do not push/i);
  assert.match(boardLoopSkill, /pin its `projectId` as the loop boundary/i);
  assert.match(boardLoopSkill, /same pinned `projectId`/i);
  assert.match(boardLoopSkill, /without changing `projectId`/i);
  assert.match(boardLoopSkill, /NO_ELIGIBLE_TASK[\s\S]*stop this worker/i);
  assert.match(boardLoopSkill, /never scan or claim from another project/i);
  assert.match(boardLoopSkill, /explicitly asks to switch boards\/projects/i);
  assert.match(boardLoopSkill, /`loop board`[\s\S]*`ทำต่อ`[\s\S]*`ปิดงาน`[\s\S]*`ทำให้จบ`/i);
  assert.match(boardLoopSkill, /continue-until-terminal/i);
  assert.match(boardLoopSkill, /non-terminal milestones[\s\S]*tests? pass[\s\S]*accepted\/running durable job[\s\S]*child[\s\S]*parent\/program[\s\S]*clean commit[\s\S]*finalization[\s\S]*cleanup/i);
  assert.match(boardLoopSkill, /exact accepted\/running durable job[\s\S]*get_tool_job_result[\s\S]*until terminal/i);
  assert.match(boardLoopSkill, /foreign dirty WIP[\s\S]*safe non-overlapping eligible work[\s\S]*no safe alternate/i);
  assert.match(boardLoopSkill, /requested parent\/program[\s\S]*terminal/i);
  assert.match(boardLoopSkill, /tool\/runtime surface[\s\S]*unavailable/i);
  for (const delegatedDetail of [
    'RED-required',
    'RED-deferred',
    'Focused GREEN',
    'resource pressure',
    'prepare_compact_edit',
    'apply_prepared_edit',
    'apply_and_verify',
  ]) {
    assert.doesNotMatch(boardLoopSkill, new RegExp(delegatedDetail), `08 must delegate ${delegatedDetail}`);
  }
});

test('runtime execution prompt stays compact and worker-focused', () => {
  assert.equal(Buffer.byteLength(executionRules) <= 3_500, true);
  assert.match(executionRules, /Fetch DevFlow context only when needed, but do not guess task requirements/);
  assert.match(executionRules, /get_tool_job_result/);
  assert.match(executionRules, /same assistant turn/i);
  assert.match(executionRules, /UNDERSTAND\/DESIGN[\s\S]*IMPLEMENT[\s\S]*VERIFY/i);
  assert.match(executionRules, /bug[\s\S]*(?:reproduc|defect evidence)/i);
  assert.match(executionRules, /existing evidence|existing failing test|focused test/i);
  assert.match(executionRules, /without intermediate tests|no intermediate/i);
  assert.match(executionRules, /one frozen candidate|same frozen candidate/i);
  assert.match(executionRules, /parallel[\s\S]*(?:final verification|verification batch)|(?:final verification|verification batch)[\s\S]*parallel/i);
  assert.match(executionRules, /do not mutate[\s\S]*(?:final verification|verification batch)|(?:final verification|verification batch)[\s\S]*do not mutate/i);
  assert.match(executionRules, /join[\s\S]*required|all required[\s\S]*join/i);
  assert.match(executionRules, /another revision[\s\S]*invalid|other revision[\s\S]*invalid|evidence[\s\S]*same frozen candidate/i);
  assert.doesNotMatch(executionRules, /Testable changes:\s*RED\s*→\s*IMPLEMENT\s*→\s*GREEN/i);
  assert.doesNotMatch(executionRules, /exactly two|test-first|TDD/i);
  assert.match(executionRules, /Work only on this current task and stop when it is complete/);
  assert.doesNotMatch(executionRules, /01-authoring-core|02-schema-reference|03-reviewer-core|open_task_bug/);
});

test('legacy schema document is a thin compatibility note backed by live schema truth', () => {
  assert.equal(Buffer.byteLength(legacySchema) <= 2_000, true, `legacy schema should be a thin pointer, got ${Buffer.byteLength(legacySchema)}`);
  assert.match(legacySchema, /compatibility/i);
  assert.match(legacySchema, /get_tool_schema/);
  assert.match(legacySchema, /02-schema-reference/);
  assert.match(legacySchema, /live.*schema|schema.*live/i);
  assert.doesNotMatch(legacySchema, /GPT-5\.6 Sol|Allowed Values|Agent\/Model Mapping/);
});

test('master skill registry descriptions match canonical responsibilities', () => {
  assert.match(skillsRepository, /03-reviewer-core[^\n]+ready-for-review/i);
  assert.doesNotMatch(skillsRepository, /03-reviewer-core[^\n]+before they are ready for implementation/i);
  assert.match(skillsRepository, /02-schema-reference[^\n]+semantic/i);
  assert.match(skillsRepository, /07-authoring-execution[^\n]+workspace/i);
  assert.match(skillsRepository, /08-board-loop-execution[^\n]+orchestration/i);
});
