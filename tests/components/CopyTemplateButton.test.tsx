import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CopyTemplateButton, {
  copyPromptPath,
  resolveCopyPromptTaskId,
  runCodexPromptCopy,
} from '../../src/components/CopyTemplateButton.js';

function response(ok: boolean, text: string) {
  return { ok, text: async () => text } as Response;
}

const task = {
  id: 'task-internal-1',
  displayId: 'DVF-0700',
  title: 'Copy for Codex',
  status: 'todo',
  priority: 'medium',
  projectId: 'project-test',
  tags: [],
  targetFiles: [],
  checklist: [],
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
} as any;

test('full and icon variants identify Codex without adding execution controls', () => {
  const full = renderToStaticMarkup(React.createElement(CopyTemplateButton, { task, variant: 'full' }));
  const icon = renderToStaticMarkup(React.createElement(CopyTemplateButton, { task, variant: 'icon' }));

  assert.match(full, />Copy for Codex</);
  assert.match(full, /title="Copy for Codex"/);
  assert.match(icon, /aria-label="Copy for Codex"/);
  assert.doesNotMatch(full + icon, /agent selector|engine selector|workspace|verification|finalize/i);
});

test('prompt endpoint uses displayId when present and task id as fallback', () => {
  assert.equal(resolveCopyPromptTaskId(task), 'DVF-0700');
  assert.equal(resolveCopyPromptTaskId({ id: 'task-fallback' } as any), 'task-fallback');
  assert.equal(copyPromptPath('DVF-0700'), '/api/tasks/DVF-0700/prompt');  assert.equal(copyPromptPath('task-fallback'), '/api/tasks/task-fallback/prompt');
});

test('successful copy fetches one server prompt and copies exactly that text', async () => {
  const requested: string[] = [];
  const copied: string[] = [];
  const text = 'server-authored Codex prompt\nwith exact bytes';

  const result = await runCodexPromptCopy(
    'DVF-0700',
    async (url) => { requested.push(url); return response(true, text); },
    async (value) => { copied.push(value); },
  );

  assert.equal(result, text);
  assert.deepEqual(requested, ['/api/tasks/DVF-0700/prompt']);
  assert.deepEqual(copied, [text]);
});

test('HTTP failure rejects before clipboard write', async () => {
  let copied = false;
  await assert.rejects(
    runCodexPromptCopy('DVF-0700', async () => response(false, 'error body'), async () => { copied = true; }),
    /Failed to load prompt/,
  );
  assert.equal(copied, false);
});

test('clipboard rejection propagates so the component can show temporary failure feedback', async () => {
  await assert.rejects(
    runCodexPromptCopy('DVF-0700', async () => response(true, 'copy me'), async () => { throw new Error('clipboard denied'); }),
    /clipboard denied/,
  );
});

test('repeated invocation fetches a fresh server response for each copy', async () => {
  let requestCount = 0;
  const copied: string[] = [];
  const request = async () => {
    requestCount += 1;
    return response(true, `prompt-${requestCount}`);
  };

  await Promise.all([
    runCodexPromptCopy('DVF-0700', request, async (value) => { copied.push(value); }),
    runCodexPromptCopy('DVF-0700', request, async (value) => { copied.push(value); }),
  ]);

  assert.equal(requestCount, 2);
  assert.deepEqual(copied.sort(), ['prompt-1', 'prompt-2']);
});

test('component keeps card click propagation isolated and preserves copied/error timers', () => {
  const source = fs.readFileSync('src/components/CopyTemplateButton.tsx', 'utf8');
  assert.match(source, /e\.stopPropagation\(\)/);
  assert.match(source, /setStatus\('copied'\)/);
  assert.match(source, /setStatus\('error'\)/);
  assert.match(source, /setTimeout\(\(\) => setStatus\('idle'\), 2000\)/);
  assert.match(source, /setTimeout\(\(\) => setStatus\('idle'\), 3000\)/);
  assert.match(source, /runCodexPromptCopy\(displayId, fetch, copyText\)/);
});
