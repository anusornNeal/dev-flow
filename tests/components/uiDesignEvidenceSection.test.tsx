import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import UiDesignEvidenceSection from '../../src/components/taskDrawer/UiDesignEvidenceSection.js';
import type { TaskUiEvidence } from '../../src/client/uiPreviewClient.js';

function evidence(overrides: Partial<TaskUiEvidence> = {}): TaskUiEvidence {
  return {
    evidenceId: 'ev-a2',
    taskId: 'task-1',
    previewId: 'preview-a',
    title: 'Preview A',
    frozenRevision: 2,
    latestRevision: 3,
    frozenPreviewUrl: 'http://127.0.0.1:3000/previews/a/2',
    latestPreviewUrl: 'http://127.0.0.1:3000/previews/a/latest',
    screenshotUrl: 'http://127.0.0.1:3000/artifacts/a2.png',
    attachedAt: '2026-08-11T02:05:00.000Z',
    current: true,
    spec: {
      schemaVersion: 1,
      summary: { screen: 'Checkout', purpose: 'Review purchase' },
      layout: { sections: ['Header', 'Cart'] },
      emptySection: {},
    },
    ...overrides,
  };
}

test('section hides when there is no evidence', () => {
  const html = renderToStaticMarkup(React.createElement(UiDesignEvidenceSection as any, { evidence: [] }));
  assert.equal(html, '');
});

test('section keeps one current card per preview, newest first, and groups older revisions', () => {
  const html = renderToStaticMarkup(React.createElement(UiDesignEvidenceSection as any, {
    evidence: [
      evidence(),
      evidence({ evidenceId: 'ev-a2-duplicate', attachedAt: '2026-08-11T02:04:59.000Z' }),
      evidence({
        evidenceId: 'ev-a1',
        frozenRevision: 1,
        latestRevision: 3,
        current: false,
        attachedAt: '2026-08-11T01:00:00.000Z',
        frozenPreviewUrl: 'http://127.0.0.1:3000/previews/a/1',
        screenshotUrl: 'http://127.0.0.1:3000/artifacts/a1.png',
      }),
      evidence({
        evidenceId: 'ev-b1',
        previewId: 'preview-b',
        title: 'Preview B',
        frozenRevision: 1,
        latestRevision: 1,
        current: true,
        attachedAt: '2026-08-11T02:10:00.000Z',
        frozenPreviewUrl: 'http://127.0.0.1:3000/previews/b/1',
        latestPreviewUrl: 'http://127.0.0.1:3000/previews/b/latest',
        screenshotUrl: 'http://127.0.0.1:3000/artifacts/b1.png',
        spec: { schemaVersion: 1, summary: { screen: 'Dashboard' } },
      }),
    ],
  }));

  assert.match(html, /UI Design/);
  assert.ok(html.indexOf('Preview B') < html.indexOf('Preview A'));
  assert.equal((html.match(/>Preview A<\/div>/g) || []).length, 1);
  assert.match(html, /Previous revisions/);
  assert.match(html, /Revision 1/);
  assert.match(html, /Revision 2/);
  assert.equal((html.match(/aria-label="Open Design: [^"]+"/g) || []).length, 2);
  assert.equal((html.match(/>Open Preview</g) || []).length, 1, 'only historical evidence keeps Open Preview');
  assert.match(html, /Open Latest/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /artifacts\/a2\.png/);
  assert.doesNotMatch(html, /emptySection/);
});

test('current frozen screenshot is the safe Open Design target and missing frozen URL is not clickable', () => {
  const clickable = renderToStaticMarkup(React.createElement(UiDesignEvidenceSection as any, {
    evidence: [evidence()],
  }));
  assert.match(clickable, /aria-label="Open Design: Preview A"/);
  assert.match(clickable, /href="http:\/\/127\.0\.0\.1:3000\/previews\/a\/2"/);
  assert.match(clickable, /rel="noopener noreferrer"/);

  const withoutFrozenUrl = renderToStaticMarkup(React.createElement(UiDesignEvidenceSection as any, {
    evidence: [evidence({ frozenPreviewUrl: '' })],
  }));
  assert.match(withoutFrozenUrl, /artifacts\/a2\.png/);
  assert.doesNotMatch(withoutFrozenUrl, /Open Design/);
});

test('Open Latest appears only when backend latestRevision is newer than frozen revision', () => {
  const html = renderToStaticMarkup(React.createElement(UiDesignEvidenceSection as any, {
    evidence: [evidence({ latestRevision: 2 })],
  }));
  assert.match(html, /Open Design/);
  assert.doesNotMatch(html, />Open Preview</);
  assert.doesNotMatch(html, /Open Latest/);
});
