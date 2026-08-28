import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CopyTemplateButton from '../../src/components/CopyTemplateButton.js';

const modalFiles = [
  'src/components/SkillsModal.tsx',
  'src/components/TemplateModal.tsx',
  'src/components/ObservabilityModal.tsx',
  'src/components/AgentRunLogModal.tsx',
] as const;

function source(path: string) {
  return fs.readFileSync(path, 'utf8');
}

const task = {
  id: 'task-utility-copy',
  displayId: 'DVF-UTILITY',
  title: 'Utility modal fixture',
  status: 'todo',
  priority: 'medium',
  projectId: 'project-test',
  tags: [],
  targetFiles: [],
  checklist: [],
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
} as any;

test('developer utility dialogs use the shared dialog shell and accessible modal labels', () => {
  for (const path of modalFiles) {
    const content = source(path);
    assert.match(content, /df-dialog-backdrop/, `${path} should use the shared dialog backdrop`);
    assert.match(content, /df-dialog/, `${path} should use the shared dialog surface`);
    assert.match(content, /role="dialog"/, `${path} should expose dialog semantics`);
    assert.match(content, /aria-modal="true"/, `${path} should expose modal semantics`);
    assert.match(content, /aria-label="Close/, `${path} should label its close control`);
  }
});

test('all utility overlays support Escape close without changing their underlying actions', () => {
  for (const path of [...modalFiles, 'src/components/ImageViewer.tsx']) {
    const content = source(path);
    assert.match(content, /Escape/, `${path} should handle Escape`);
    assert.match(content, /addEventListener\('keydown'|addEventListener\("keydown"/, `${path} should install a keyboard close handler`);
    assert.match(content, /removeEventListener\('keydown'|removeEventListener\("keydown"/, `${path} should remove its keyboard close handler`);
  }
});

test('log, template, skill, diagnostics, and image metadata have bounded overflow contracts', () => {
  const log = source('src/components/AgentRunLogModal.tsx');
  const template = source('src/components/TemplateModal.tsx');
  const skills = source('src/components/SkillsModal.tsx');
  const observability = source('src/components/ObservabilityModal.tsx');
  const image = source('src/components/ImageViewer.tsx');

  assert.match(log, /df-break-technical/);
  assert.match(log, /overflow-auto/);
  assert.match(log, /whitespace-pre-wrap/);
  assert.match(template, /df-break-technical/);
  assert.match(template, /overflow-y-auto/);
  assert.match(skills, /break-words/);
  assert.match(skills, /overflow-y-auto/);
  assert.match(observability, /df-break-technical/);
  assert.match(observability, /overflow-y-auto/);
  assert.match(image, /break-words/);
  assert.match(image, /max-h-\[85vh\]/);
});

test('utility loading, error, empty, and copy feedback use shared state semantics', () => {
  const observability = source('src/components/ObservabilityModal.tsx');
  const log = source('src/components/AgentRunLogModal.tsx');
  const copy = source('src/components/CopyTemplateButton.tsx');

  assert.match(observability, /df-feedback--danger/);
  assert.match(observability, /Loading diagnostics/);
  assert.match(observability, /No active jobs/);
  assert.match(log, /df-feedback--danger/);
  assert.match(log, /Loading log/);
  assert.match(log, /No log file for this run yet/);
  assert.match(copy, /aria-live="polite"/);
  assert.match(copy, /df-button/);
  assert.match(copy, /df-feedback--success|df-feedback--danger/);
});

test('copy template button keeps both full and icon variants compact and accessible', () => {
  const full = renderToStaticMarkup(React.createElement(CopyTemplateButton, { task, variant: 'full' }));
  const icon = renderToStaticMarkup(React.createElement(CopyTemplateButton, { task, variant: 'icon' }));
  assert.match(full, /df-button/);
  assert.match(full, /Copy for Codex/);
  assert.match(icon, /aria-label="Copy for Codex"/);
  assert.match(full + icon, /aria-live="polite"/);
});

test('image viewer preserves open-in-new-tab behavior and exposes a labeled close action', () => {
  const image = source('src/components/ImageViewer.tsx');
  assert.match(image, /target="_blank"/);
  assert.match(image, /rel="noreferrer"/);
  assert.match(image, /aria-label="Close image viewer"/);
  assert.doesNotMatch(image, /Download/);
});
