import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../../src/components/Header.js';
import fs from 'node:fs';

const noop = () => {};

test('Header no longer renders the legacy Auto Work control', () => {
  const source = fs.readFileSync('src/components/Header.tsx', 'utf8');
  assert.doesNotMatch(source, /AutoWorkToggle/);

  const html = renderToStaticMarkup(React.createElement(Header as any, {
    filteredTasksCount: 3,
    ngrokUrl: null,
    theme: 'light',
    setTheme: noop,
    setIsSettingsModalOpen: noop,
    setIsJsonModalOpen: noop,
    setIsSkillsModalOpen: noop,
    setIsTemplateModalOpen: noop,
    setIsObservabilityModalOpen: noop,
    setIsCreateModalOpen: noop,
    setIsBatchModalOpen: noop,
  }));
  assert.doesNotMatch(html, /Auto Work/);
});

test('normal Board move flow no longer emits legacy Auto Work preflight UI events', () => {
  const source = fs.readFileSync('src/App.tsx', 'utf8');
  assert.doesNotMatch(source, /devflow:auto-work-preflight-error/);
  assert.doesNotMatch(source, /Auto Work blocked before launch/);
});

test('legacy AutoWorkToggle source is retained for future redesign', () => {
  assert.equal(fs.existsSync('src/components/AutoWorkToggle.tsx'), true);
});
