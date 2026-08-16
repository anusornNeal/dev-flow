import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../../src/components/Header.js';
import fs from 'node:fs';

const noop = () => {};

function renderHeader() {
  return renderToStaticMarkup(React.createElement(Header as any, {
    filteredTasksCount: 3,
    theme: 'light',
    setTheme: noop,
    setIsSkillsModalOpen: noop,
    setIsTemplateModalOpen: noop,
    setIsObservabilityModalOpen: noop,
    setIsCreateModalOpen: noop,
    setIsBatchModalOpen: noop,
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

test('Header uses live zrok status UI without a configured tunnel URL prop', () => {
  const source = fs.readFileSync('src/components/Header.tsx', 'utf8');
  assert.match(source, /ZrokStatusPanel/);
  assert.doesNotMatch(source, /NgrokStatusPanel|ngrokUrl/);

  const html = renderHeader();
  assert.match(html, /zrok status: Starting/);
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

test('legacy AutoWorkToggle source is retained for future redesign', () => {
  assert.equal(fs.existsSync('src/components/AutoWorkToggle.tsx'), true);
});
