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

test('sidebar keeps Board layout controls without Atlas navigation state', () => {
  const source = fs.readFileSync('src/components/Sidebar.tsx', 'utf8');
  const appSource = fs.readFileSync('src/App.tsx', 'utf8');
  assert.doesNotMatch(source, /activePage|onSetActivePage|Project Atlas|Waypoints/);
  assert.doesNotMatch(appSource, /isAtlasSidebarCollapsed/);
  assert.match(appSource, /isCollapsed=\{sidebarLayout\.collapsed\}/);
  assert.match(appSource, /width=\{sidebarLayout\.width\}/);
});
