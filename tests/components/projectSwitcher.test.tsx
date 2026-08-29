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
  resolveProjectSwitcherPopoverLayout,
} from '../../src/components/ProjectSwitcher.js';
import * as ProjectSwitcherModule from '../../src/components/ProjectSwitcher.js';

const projectSwitcherHelpers = ProjectSwitcherModule as any;

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

test('project search preserves explicit project order instead of moving the active project first', () => {
  assert.equal(typeof projectSwitcherHelpers.orderProjects, 'function');
  const ordered = projectSwitcherHelpers.orderProjects(projects, ['sumora', 'atlas', 'devflow']);
  assert.deepEqual(filterProjectOptions(ordered, '').map((project) => project.id), ['sumora', 'atlas', 'devflow']);
  assert.deepEqual(filterProjectOptions(ordered, 'github.com/example').map((project) => project.id), ['sumora', 'atlas']);
  assert.deepEqual(filterProjectOptions(ordered, 'anusornNeal').map((project) => project.id), ['devflow']);
  assert.deepEqual(filterProjectOptions(ordered, 'sumora-desktop').map((project) => project.id), ['sumora']);
});

test('stored order reconciliation ignores deleted ids, de-duplicates entries, and appends new projects deterministically', () => {
  assert.equal(typeof projectSwitcherHelpers.reconcileProjectOrder, 'function');
  assert.deepEqual(
    projectSwitcherHelpers.reconcileProjectOrder(projects, ['sumora', 'deleted-project', 'sumora', 'atlas']),
    ['sumora', 'atlas', 'devflow'],
  );
  const withNewProject = [...projects, { id: 'new-project', name: 'New Project' } as any];
  assert.deepEqual(
    projectSwitcherHelpers.reconcileProjectOrder(withNewProject, ['sumora', 'atlas', 'devflow']),
    ['sumora', 'atlas', 'devflow', 'new-project'],
  );
});

test('reorder helper moves one project at a time and respects list boundaries', () => {
  assert.equal(typeof projectSwitcherHelpers.moveProjectOrder, 'function');
  assert.deepEqual(projectSwitcherHelpers.moveProjectOrder(['atlas', 'devflow', 'sumora'], 'sumora', -1), ['atlas', 'sumora', 'devflow']);
  assert.deepEqual(projectSwitcherHelpers.moveProjectOrder(['atlas', 'devflow', 'sumora'], 'atlas', -1), ['atlas', 'devflow', 'sumora']);
  assert.deepEqual(projectSwitcherHelpers.moveProjectOrder(['atlas', 'devflow', 'sumora'], 'sumora', 1), ['atlas', 'devflow', 'sumora']);
});

test('project order persistence uses a versioned storage key and tolerates invalid stored data', () => {
  assert.match(projectSwitcherHelpers.PROJECT_SWITCHER_ORDER_STORAGE_KEY || '', /v1/);
  assert.equal(typeof projectSwitcherHelpers.readProjectOrder, 'function');
  assert.equal(typeof projectSwitcherHelpers.writeProjectOrder, 'function');
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  projectSwitcherHelpers.writeProjectOrder(storage, ['sumora', 'atlas', 'devflow']);
  assert.equal(values.get(projectSwitcherHelpers.PROJECT_SWITCHER_ORDER_STORAGE_KEY), '["sumora","atlas","devflow"]');
  assert.deepEqual(projectSwitcherHelpers.readProjectOrder(storage), ['sumora', 'atlas', 'devflow']);
  values.set(projectSwitcherHelpers.PROJECT_SWITCHER_ORDER_STORAGE_KEY, '{invalid');
  assert.deepEqual(projectSwitcherHelpers.readProjectOrder(storage), []);
});

test('initial empty project loads do not erase stored order before project data arrives', () => {
  const source = fs.readFileSync('src/components/ProjectSwitcher.tsx', 'utf8');
  assert.match(source, /useState<string\[\]>\(\(\) => typeof window === 'undefined' \? \[\] : readProjectOrder\(window\.localStorage\)\)/);
  assert.match(source, /projectsLoadedRef/);
  assert.match(source, /if \(projects\.length > 0\) projectsLoadedRef\.current = true/);
});

test('keyboard navigation resolves Escape, Up/Down, and Enter deterministically', () => {
  assert.deepEqual(resolveProjectSwitcherKeyAction('ArrowDown', 0, 3), { type: 'highlight', index: 1 });
  assert.deepEqual(resolveProjectSwitcherKeyAction('ArrowUp', 0, 3), { type: 'highlight', index: 2 });
  assert.deepEqual(resolveProjectSwitcherKeyAction('Enter', 1, 3), { type: 'select', index: 1 });
  assert.deepEqual(resolveProjectSwitcherKeyAction('Escape', 1, 3), { type: 'close' });
});

test('project switcher popover clamps its fixed panel inside the viewport', () => {
  const wide = resolveProjectSwitcherPopoverLayout({ left: 900, bottom: 64 }, 1000, 700);
  assert.equal(wide.width, 500);
  assert.equal(wide.left + wide.width <= 984, true);
  assert.equal(wide.top >= 16, true);
  assert.equal(wide.top + wide.maxHeight <= 684, true);

  const narrow = resolveProjectSwitcherPopoverLayout({ left: 280, bottom: 64 }, 320, 600);
  assert.equal(narrow.width, 288);
  assert.equal(narrow.left, 16);
  assert.equal(narrow.left + narrow.width, 304);
});

test('project switcher uses a viewport portal and document-level Escape dismissal', () => {
  const source = fs.readFileSync('src/components/ProjectSwitcher.tsx', 'utf8');
  assert.match(source, /createPortal\(popover, document\.body\)/);
  assert.match(source, /document\.addEventListener\('keydown', handleKeyDown\)/);
  assert.match(source, /if \(event\.key === 'Escape'\) close\(true\)/);
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
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(PROJECT_SWITCHER_POPOVER_CLASS, /w-\[500px\]/);
});

test('project rows use compact spacing without shrinking action hit targets', () => {
  const source = fs.readFileSync('src/components/ProjectSwitcher.tsx', 'utf8');
  assert.match(source, /px-2\.5 py-1\.5 text-left/);
  assert.match(source, /h-7 w-7 items-center justify-center/);
  assert.match(source, /overflow-y-auto p-1\.5/);
});

test('full project values are preserved for labels and tooltips', () => {
  assert.equal(formatProjectRepoLabel(projects[1].repoUrl), 'github.com/anusornNeal/dev-flow');
  const source = fs.readFileSync('src/components/ProjectSwitcher.tsx', 'utf8');
  assert.match(source, /title=\{project\.repoUrl/);
  assert.match(source, /title=\{project\.localPath/);
});

test('project rows expose accessible move up and move down controls', () => {
  const source = fs.readFileSync('src/components/ProjectSwitcher.tsx', 'utf8');
  assert.match(source, /Move \$\{project\.name\} up/);
  assert.match(source, /Move \$\{project\.name\} down/);
  assert.match(source, /moveProjectOrder/);
});

test('Sidebar no longer owns the primary interactive project selector', () => {
  const source = fs.readFileSync('src/components/Sidebar.tsx', 'utf8');
  assert.doesNotMatch(source, /Interactive Project Selector/);
  assert.doesNotMatch(source, /isProjectDropdownOpen/);
});
test('App routes one active project id through the switcher and Board only', () => {
  const source = fs.readFileSync('src/App.tsx', 'utf8');
  assert.match(source, /<ProjectSwitcher[\s\S]*activeProjectId=\{activeProjectId\}[\s\S]*setActiveProjectId=\{setActiveProjectId\}/);
  assert.match(source, /useBoardViewModel\(\{[\s\S]*projectId: activeProjectId \|\| null/);
  assert.doesNotMatch(source, /ProjectAtlasPage|atlasEventRevision|Project Atlas/);
  assert.match(source, /activePage.*'board'.*'previews'/s);
});
