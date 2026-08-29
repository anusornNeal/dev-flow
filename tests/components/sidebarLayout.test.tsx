import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import Sidebar from '../../src/components/Sidebar.js';

const noop = () => {};
const tasks: any[] = [];
const projects: any[] = [{ id: 'p1', name: 'Dev Flow', taskIdPrefix: 'DVF' }];

function renderSidebar(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(React.createElement(Sidebar as any, {
    tasks,
    projects,
    activeProjectId: 'p1',
    selectedPriority: 'all',
    setSelectedPriority: noop,
    selectedTag: 'all',
    setSelectedTag: noop,
    searchQuery: '',
    setSearchQuery: noop,
    onOpenSettings: noop,
    activePage: 'board',
    onSetActivePage: noop,
    isCollapsed: false,
    width: 320,
    onToggleCollapsed: noop,
    onWidthChange: noop,
    ...overrides,
  }));
}

test('collapsed sidebar is a 64px global rail with navigation, filter, and settings access', () => {
  const html = renderSidebar({ isCollapsed: true });
  assert.match(html, /width:64px/);
  assert.match(html, /aria-label="Expand sidebar"/);
  assert.match(html, /title="Sprint Board"/);
  assert.match(html, /title="UI Previews"/);
  assert.doesNotMatch(html, /Project Atlas/);
  assert.match(html, /title="Search and filters"/);
  assert.match(html, /title="Settings"/);
});

test('expanded sidebar uses persisted width and exposes an accessible horizontal resize handle', () => {
  const html = renderSidebar({ isCollapsed: false, width: 356 });
  assert.match(html, /width:356px/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-label="Resize sidebar"/);
  assert.match(html, /aria-label="Collapse sidebar"/);
});

test('navigation exposes one aria-current destination and lets long labels use available width', () => {
  const html = renderSidebar({ activePage: 'previews' });
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /UI Previews/);

  const source = fs.readFileSync('src/components/Sidebar.tsx', 'utf8');
  assert.match(source, /title=\{activeProject\?\.name\}/);
  assert.doesNotMatch(source, /max-w-\[140px\]/);
  assert.match(source, /min-w-0 truncate/);
  assert.match(source, /Board filters are scoped to Sprint Board/);
});

test('priority filters stack at the minimum sidebar width and return to two columns at the default width', () => {
  const narrowHtml = renderSidebar({ width: 240 });
  const defaultHtml = renderSidebar({ width: 288 });
  assert.match(narrowHtml, /grid grid-cols-1 gap-1\.5/);
  assert.match(defaultHtml, /grid grid-cols-2 gap-1\.5/);
  assert.match(narrowHtml, /All priorities/);
});

test('shared interaction CSS gives enabled click targets a pointer while preserving disabled semantics', () => {
  const css = fs.readFileSync('src/index.css', 'utf8');
  assert.match(css, /button:not\(:disabled\)/);
  assert.match(css, /\.df-button:not\(\[aria-disabled="true"\]\)/);
  assert.match(css, /cursor: pointer/);
  assert.match(css, /:where\(button, input, textarea, select\):disabled/);
  assert.match(css, /cursor: not-allowed/);
});

test('sidebar keeps global Board/Preview navigation without resurrecting Atlas state', () => {
  const source = fs.readFileSync('src/components/Sidebar.tsx', 'utf8');
  const appSource = fs.readFileSync('src/App.tsx', 'utf8');
  assert.match(source, /activePage|onSetActivePage|UI Previews/);
  assert.doesNotMatch(source, /Project Atlas|Waypoints/);
  assert.doesNotMatch(appSource, /isAtlasSidebarCollapsed|ProjectAtlasPage|atlasEventRevision/);
  assert.match(appSource, /isCollapsed=\{sidebarLayout\.collapsed\}/);
  assert.match(appSource, /width=\{sidebarLayout\.width\}/);
});
