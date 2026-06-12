import { interpolate, renderPromptTemplate, type PromptRenderContext } from '../src/server/services/promptTemplateService';
import fs from 'fs';
import assert from 'assert';

console.log('[verify] Testing prompt template interpolation...');

const mockContext: PromptRenderContext = {
  run: { id: 'run-123' },
  task: { displayId: 'TASK-1', title: 'Test', description: 'desc', checklist: [{ text: 'item 1' }], subtasks: [] },
  project: { name: 'Proj', localPath: '/path' },
  agent: 'test-agent',
  model: 'test-model',
  effort: 'test-effort'
};

// 1. Verify missing variable interpolation yields (none)
const template1 = 'Missing: {{task.foo}} and {{task.subtasks}} and {{task.unknown.deep}}';
const result1 = interpolate(template1, mockContext);
assert.strictEqual(result1, 'Missing: (none) and (none) and (none)');

// 2. Verify simple interpolation
const template2 = 'Title: {{task.title}}, Run: {{run.id}}';
const result2 = interpolate(template2, mockContext);
assert.strictEqual(result2, 'Title: Test, Run: run-123');

// 3. Verify checklist rendering
const template3 = 'Checklist:\n{{task.checklist}}';
const result3 = interpolate(template3, mockContext);
assert.ok(result3.includes('- [ ] item 1'));

// 4. Test renderPromptTemplate ignores missing files gracefully
console.log('[verify] Testing renderPromptTemplate missing skill gracefully...');
const renderResult = renderPromptTemplate('default', mockContext);
assert.ok(renderResult.usedSkills.includes('prompt.header'));
assert.ok(renderResult.content.includes('TASK-1'));
assert.ok(renderResult.content.includes('run-123'));

// Verify an unknown agent doesn't crash but skips the specific template
const missingAgentContext = { ...mockContext, agent: 'non-existent' };
const missingRender = renderPromptTemplate('default', missingAgentContext);
assert.ok(!missingRender.usedSkills.includes('prompt.agent-specific.non-existent'));

// Verify single-task rules are present and old loop wording is excluded
assert.ok(renderResult.content.includes('Work only from this prompt'));
assert.ok(!renderResult.content.includes('repeat this loop until no \'todo\' tasks remain'));

console.log('[verify] Prompt template coverage passed!');
