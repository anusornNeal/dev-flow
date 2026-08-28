import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTitlePattern } from '../extensions/chatgpt-title-sync/src/titlePattern.js';
import { createTitleSyncCoordinator, hasTitleSyncSettingsChange } from '../extensions/chatgpt-title-sync/src/contentScript.js';
import { getConversationIdFromUrl, resolveSidebarTitleTarget } from '../extensions/chatgpt-title-sync/src/chatgptAdapter.js';
import { normalizeDevFlowBaseUrl, resolveDevFlowTitleMetadata } from '../extensions/chatgpt-title-sync/src/devflowClient.js';

test('title pattern renders supported tokens and falls back for malformed or empty patterns', () => {
  const tokens = {
    project: 'DevFlow',
    taskId: 'DVF-0747',
    taskTitle: 'Sync ChatGPT title',
    chatAlias: 'Chrome title work',
  };

  assert.equal(renderTitlePattern('{{taskId}} · {{taskTitle}}', tokens), 'DVF-0747 · Sync ChatGPT title');
  assert.equal(renderTitlePattern('{project} / {chatAlias}', tokens), 'DevFlow / Chrome title work');
  assert.equal(renderTitlePattern('{{taskId}} · {{missing}}', tokens), 'DVF-0747');
  assert.equal(renderTitlePattern('{{broken', tokens), 'DVF-0747 · Sync ChatGPT title');
  assert.equal(renderTitlePattern('{{missing}}', tokens), 'DVF-0747 · Sync ChatGPT title');
});

test('title sync coordinator waits for native stability, applies idempotently, and bounds auto-title races', () => {
  const coordinator = createTitleSyncCoordinator({ stabilityMs: 1_000, maxApplyCount: 2 });
  const input = { conversationId: 'conv-123', desiredTitle: 'DVF-0747 · Sync ChatGPT title' };

  assert.equal(coordinator.evaluate({ ...input, nativeTitle: 'New chat', nowMs: 0 }).action, 'wait');
  assert.equal(coordinator.evaluate({ ...input, nativeTitle: 'New chat', nowMs: 900 }).action, 'wait');
  assert.equal(coordinator.evaluate({ ...input, nativeTitle: 'New chat', nowMs: 1_000 }).action, 'apply');
  assert.equal(coordinator.evaluate({ ...input, nativeTitle: input.desiredTitle, nowMs: 1_050 }).action, 'noop');
  assert.equal(coordinator.evaluate({ ...input, nativeTitle: input.desiredTitle, nowMs: 1_100 }).action, 'noop');

  assert.equal(coordinator.evaluate({ ...input, nativeTitle: 'ChatGPT generated title', nowMs: 2_000 }).action, 'wait');
  assert.equal(coordinator.evaluate({ ...input, nativeTitle: 'ChatGPT generated title', nowMs: 3_000 }).action, 'apply');
  assert.equal(coordinator.evaluate({ ...input, nativeTitle: 'Another generated title', nowMs: 4_000 }).action, 'wait');
  assert.equal(coordinator.evaluate({ ...input, nativeTitle: 'Another generated title', nowMs: 5_000 }).action, 'give-up');
});

test('conversation URL and DOM adapter are bounded and leave unsupported UI untouched', () => {
  assert.equal(getConversationIdFromUrl('https://chatgpt.com/c/abc_DEF-123'), 'abc_DEF-123');
  assert.equal(getConversationIdFromUrl('https://chatgpt.com/'), null);
  assert.equal(getConversationIdFromUrl('https://example.com/c/abc'), null);

  let written = '';
  const titleNode = {
    textContent: 'Native title',
    getAttribute: () => null,
    setAttribute: (_name: string, value: string) => { written = value; },
  };
  const anchor = {
    querySelector: (selector: string) => selector.includes('dir="auto"') ? titleNode : null,
    getAttribute: () => '/c/abc_DEF-123',
    setAttribute: () => undefined,
  };
  const documentLike = {
    querySelector: (selector: string) => selector.includes('/c/abc_DEF-123') ? anchor : null,
  };

  const target = resolveSidebarTitleTarget(documentLike as any, 'abc_DEF-123');
  assert.ok(target);
  assert.equal(target?.readTitle(), 'Native title');
  target?.writeTitle('DVF-0747 · Sync ChatGPT title');
  assert.equal(titleNode.textContent, 'DVF-0747 · Sync ChatGPT title');
  assert.equal(written, 'DVF-0747 · Sync ChatGPT title');

  const unsupported = resolveSidebarTitleTarget({ querySelector: () => null } as any, 'abc_DEF-123');
  assert.equal(unsupported, null);
});

test('DevFlow client fails closed when server is unavailable or session is unresolved', async () => {
  assert.equal(normalizeDevFlowBaseUrl('http://localhost:3000/path?x=1'), 'http://localhost:3000');
  assert.equal(normalizeDevFlowBaseUrl('https://localhost:3000'), null);
  assert.equal(normalizeDevFlowBaseUrl('http://192.168.1.10:3000'), null);
  const unavailable = await resolveDevFlowTitleMetadata('http://127.0.0.1:3000', 'conv-a', async () => {
    throw new Error('offline');
  });
  assert.equal(unavailable, null);

  const unresolved = await resolveDevFlowTitleMetadata('http://127.0.0.1:3000', 'conv-a', async () => new Response(JSON.stringify({ resolved: false }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  assert.equal(unresolved, null);
});

test('settings changes invalidate cached title decisions only for relevant sync settings', () => {
  assert.equal(hasTitleSyncSettingsChange({ enabled: { newValue: false } }, 'sync'), true);
  assert.equal(hasTitleSyncSettingsChange({ pattern: { newValue: '{{chatAlias}}' } }, 'sync'), true);
  assert.equal(hasTitleSyncSettingsChange({ otherSetting: { newValue: true } }, 'sync'), false);
  assert.equal(hasTitleSyncSettingsChange({ enabled: { newValue: false } }, 'local'), false);
});
