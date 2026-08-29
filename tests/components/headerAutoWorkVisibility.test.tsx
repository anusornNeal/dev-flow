import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../../src/components/Header.js';
import fs from 'node:fs';

const noop = () => {};

function renderHeader(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(React.createElement(Header as any, {
    filteredTasksCount: 3,
    theme: 'light',
    setTheme: noop,
    setIsSkillsModalOpen: noop,
    setIsTemplateModalOpen: noop,
    setIsObservabilityModalOpen: noop,
    setIsCreateModalOpen: noop,
    setIsBatchModalOpen: noop,
    ...overrides,
  }));
}

test('Header no longer renders the legacy Auto Work control', () => {
  const source = fs.readFileSync('src/components/Header.tsx', 'utf8');
  assert.doesNotMatch(source, /AutoWorkToggle/);
  assert.doesNotMatch(source, /ChatGptStarterPromptButton/);
  assert.doesNotMatch(source, /Schema Spec/);
  assert.doesNotMatch(source, /setIsJsonModalOpen/);

  const html = renderHeader();
  assert.doesNotMatch(html, /Auto Work/);
  assert.doesNotMatch(html, /ChatGPT Starter/);
  assert.doesNotMatch(html, /Schema Spec/);
});

test('Header no longer embeds provider-specific tunnel status UI', () => {
  const source = fs.readFileSync('src/components/Header.tsx', 'utf8');
  assert.doesNotMatch(source, /ZrokStatusPanel|NgrokStatusPanel|ngrokUrl/i);

  const html = renderHeader();
  assert.doesNotMatch(html, /zrok|ngrok/i);
});

test('Header keeps page context and utilities visible while board-only actions can be hidden', () => {
  const html = renderHeader({
    title: 'Agent Office',
    subtitle: 'Operations',
    contextLabel: 'Active workers across all boards',
    showTaskActions: false,
  });
  assert.match(html, /Agent Office/);
  assert.match(html, /Operations/);
  assert.match(html, /Active workers across all boards/);
  assert.match(html, /Developer utilities/);
  assert.doesNotMatch(html, /New Ticket/);
});

test('Header menus expose Escape handling, focus restoration, and viewport-bounded panels', () => {
  const source = fs.readFileSync('src/components/Header.tsx', 'utf8');
  assert.match(source, /document\.addEventListener\('keydown', handleEscape\)/);
  assert.match(source, /actionButtonRef\.current\?\.focus\(\)/);
  assert.match(source, /utilityButtonRef\.current\?\.focus\(\)/);
  assert.match(source, /max-h-\[calc\(100vh-5rem\)\]/);
  assert.match(source, /max-w-\[calc\(100vw-2rem\)\]/);
});

test('normal Board move flow no longer emits legacy Auto Work preflight UI events', () => {
  const source = fs.readFileSync('src/App.tsx', 'utf8');
  assert.doesNotMatch(source, /devflow:auto-work-preflight-error/);
  assert.doesNotMatch(source, /Auto Work blocked before launch/);
  assert.doesNotMatch(source, /JsonTemplateModal|isJsonModalOpen|setIsJsonModalOpen/);
});

test('App and Settings no longer keep manual ngrok URL UI state', () => {
  const appSource = fs.readFileSync('src/App.tsx', 'utf8');
  const settingsSource = fs.readFileSync('src/components/SettingsModal.tsx', 'utf8');
  assert.doesNotMatch(appSource, /ngrokUrl|setNgrokUrl/);
  assert.doesNotMatch(settingsSource, /ngrokUrl|NgrokSettingsSection/);
});

test('legacy AutoWorkToggle source is removed after Auto Work retirement', () => {
  assert.equal(fs.existsSync('src/components/AutoWorkToggle.tsx'), false);
});
