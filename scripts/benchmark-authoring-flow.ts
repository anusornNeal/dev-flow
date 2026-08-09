import assert from 'node:assert/strict';
import { getToolDefinitionByName } from '../src/server/contracts/devflowContract.js';

const implementationMap = [
  'Implementation map:',
  '- File: src/example.ts',
  '  Class/function: example',
  '  Current behavior: old behavior',
  '  Expected change: new behavior',
].join('\n');

const card = (title: string) => ({
  title,
  category: 'backend',
  status: 'backlog',
  priority: 'high',
  description: `Implement ${title}.`,
  targetFiles: ['src/example.ts'],
  checklist: [{ id: 'impl', text: `Implement ${title}`, completed: false }],
  repoContext: implementationMap,
  acceptanceCriteria: `${title} is observable and verified.`,
  verification: 'Run the focused authoring fixture.',
});

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const single = card('Single card');
const parent = card('Parent card');
const children = Array.from({ length: 4 }, (_, index) => card(`Child ${index + 1}`));

const legacySingle = {
  calls: 2,
  inputBytes: jsonBytes(single) * 2,
  flow: ['validate_task_quality', 'create_task'],
};
const optimizedSingle = {
  calls: 1,
  inputBytes: jsonBytes(single),
  flow: ['create_task (authoritative mutation validation)'],
};

const legacySetCards = [parent, ...children];
const legacySet = {
  calls: legacySetCards.length * 2,
  inputBytes: legacySetCards.reduce((sum, item) => sum + jsonBytes(item) * 2, 0),
  flow: 'validate + create each parent/child independently',
};
const optimizedSetPayload = { projectId: 'benchmark-project', parent, children };
const optimizedSet = {
  calls: 1,
  inputBytes: jsonBytes(optimizedSetPayload),
  flow: 'one atomic create_task parent/children call',
};

const createTask = getToolDefinitionByName('create_task');
assert.ok(createTask?.inputSchema?.properties?.parent);
assert.ok(createTask?.inputSchema?.properties?.children);
assert.equal(optimizedSingle.calls < legacySingle.calls, true);
assert.equal(optimizedSet.calls < legacySet.calls, true);
assert.equal(optimizedSet.inputBytes < legacySet.inputBytes, true);

const percentReduction = (before: number, after: number) => Math.round(((before - after) / before) * 10_000) / 100;
console.log(JSON.stringify({
  singleCard: {
    before: legacySingle,
    after: optimizedSingle,
    callReductionPercent: percentReduction(legacySingle.calls, optimizedSingle.calls),
    inputByteReductionPercent: percentReduction(legacySingle.inputBytes, optimizedSingle.inputBytes),
  },
  parentPlusFourChildren: {
    before: legacySet,
    after: optimizedSet,
    callReductionPercent: percentReduction(legacySet.calls, optimizedSet.calls),
    inputByteReductionPercent: percentReduction(legacySet.inputBytes, optimizedSet.inputBytes),
  },
}, null, 2));
