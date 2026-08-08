import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import ProjectSwitcher, {
  PROJECT_SWITCHER_POPOVER_CLASS,
  filterProjectOptions,
  formatProjectRepoLabel,
  resolveProjectSwitcherKeyAction,
} from '../../src/components/ProjectSwitcher.js';

const projects = [
  {
    id: 'atlas',
    name: 'Project Atlas Mobile',
    repoUrl: 'https://github.com/example/atlas-mobile',
    localPath: 'C:/work/projects/atlas-mobile',
    taskIdPrefix: 'ATM',
  },
  {
    id: 'devflow',
    name: 'Dev Flow',
    repoUrl: 'https://github.com/anusornNeal/dev-flow',
    localPath: 'C:/work/dev-flow',
    taskIdPrefix: 'DVF',
  },
  {
    id: 'sumora',
    name: 'Sumora Desktop',
    repoUrl: 'https://github.com/example/sumora',
    localPath: 'D:/apps/sumora-desktop',
    taskIdPrefix: 'BSA',
  },
] as any[];

const noop = () => {};
const asyncTrue = async () => true;

test('project search matches name, repository, and local path while active project stays first', () => {
  assert.deepEqual(filterProjectOptions(projects, '', 'devflow').map((project) => project.id), ['devflow', 'atlas', 'sumora']);
  assert.deepEqual(filterProjectOptions(projects, 'atlas mobile', 'devflow').map((project) => project.id), ['atlas']);
  assert.deepEqual(filterProjectOptions(projects, 'anusornNeal', 'devflow').map((project) => project.id), ['devflow']);
  assert.deepEqual(filterProjectOptions(projects, 'sumora-desktop', 'devflow').map((project) => project.id), ['sumora']);
});

test('keyboard navigation resolves Escape, Up/Down, and Enter deterministically', () => {
  assert.deepEqual(resolveProjectSwitcherKeyAction('ArrowDown', 0, 3), { type: 'highlight', index: 1 });
  assert.deepEqual(resolveProjectSwitcherKeyAction('ArrowUp', 0, 3), { type: 'highlight', index: 2 });
  assert.deepEqual(resolveProjectSwitcherKeyAction('Enter', 1, 3), { type: 'select', index: 1 });
  assert.deepEqual(resolveProjectSwitcherKeyAction('Escape', 1, 3), { type: 'close' });
});

test('switcher trigger gives the active project a large readable workspace control', () => {
  const html = renderToStaticMarkup(React.createElement(ProjectSwitcher as any, {
    projects,
    activeProjectId: 'devflow',
    setActiveProjectId: noop,
    onCreateProject: asyncTrue,
    onDeleteProject: asyncTrue,
    onUpdateProject: asyncTrue,
  }));
  assert.match(html, /Dev Flow/);
  assert.match(html, /github\.com\/anusornNeal\/dev-flow/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(PROJECT_SWITCHER_POPOVER_CLASS, /w-\[400px\]/);
});

test('full project values are preserved for labels and tooltips', () => {
  assert.equal(formatProjectRepoLabel(projects[1].repoUrl), 'github.com/anusornNeal/dev-flow');
  const source = fs.readFileSync('src/components/ProjectSwitcher.tsx', 'utf8');
  assert.match(source, /title=\{project\.repoUrl/);
  assert.match(source, /title=\{project\.localPath/);
});

test('Sidebar no longer owns the primary interactive project selector', () => {
  const source = fs.readFileSync('src/components/Sidebar.tsx', 'utf8');
  assert.doesNotMatch(source, /Interactive Project Selector/);
  assert.doesNotMatch(source, /isProjectDropdownOpen/);
});
test('App routes one active project id through the switcher, Board, and Atlas', () => {
  const source = fs.readFileSync('src/App.tsx', 'utf8');
  assert.match(source, /<ProjectSwitcher[\s\S]*activeProjectId=\{activeProjectId\}[\s\S]*setActiveProjectId=\{setActiveProjectId\}/);
  assert.match(source, /useBoardViewModel\(\{[\s\S]*projectId: activeProjectId \|\| null/);
  assert.match(source, /<ProjectAtlasPage projectId=\{activeProjectId \|\| null\}/);
  assert.doesNotMatch(source, /activePage !== 'atlas' && \(\s*<Header/);
});
