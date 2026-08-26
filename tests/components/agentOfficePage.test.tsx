import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentOfficePage, {
  formatActivityAge,
  isAgentOfficeSnapshotStale,
} from '../../src/components/AgentOfficePage.js';
import type { AgentOfficeProjection } from '../../src/client/apiClient.js';

const generatedAt = '2026-08-26T10:00:00.000Z';

function makeSnapshot(overrides: Partial<AgentOfficeProjection> = {}): AgentOfficeProjection {
  return {
    schema: 'agent-office-monitor.v1',
    projectId: 'project-1',
    generatedAt,
    limit: 20,
    workers: {
      total: 1,
      truncated: false,
      items: [{
        taskId: 'task-1',
        displayId: 'DVF-0738',
        title: 'Agent Office',
        ownerLabel: 'Chat 0738',
        ownerKind: 'chat',
        source: 'devflow-managed',
        action: 'Implement monitoring UI',
        phase: 'implementation',
        phaseLabel: 'Implementing',
        queueState: 'execution',
        ageMs: 65_000,
        updatedAt: generatedAt,
        stale: false,
        failure: false,
        indicator: null,
        reasonCodes: [],
      }],
    },
    pipeline: {
      total: 1,
      truncated: false,
      sourceTruncated: false,
      items: [{
        taskId: 'task-2',
        displayId: 'DVF-0737',
        title: 'Monitoring projection',
        executionSessionId: 'exec-1',
        ownerLabel: 'Chat 0737',
        stage: 'verifying',
        lifecycleStage: 'verifying',
        operationKind: 'verification',
        operationStatus: 'running',
        blocked: false,
        activity: 'Run focused checks',
        updatedAt: generatedAt,
      }],
    },
    queue: {
      counts: { ready: 1, execution: 1, attention: 1, blocked: 1 },
      items: {
        ready: [{ taskId: 'task-ready', displayId: 'DVF-0740', title: 'Ready task', taskStatus: 'todo', reasons: [] }],
        execution: [{ taskId: 'task-execution', displayId: 'DVF-0738', title: 'Running task', taskStatus: 'in-progress', reasons: [] }],
        attention: [{ taskId: 'task-attention', displayId: 'DVF-0739', title: 'Needs attention', taskStatus: 'in-progress', reasons: [{ code: 'ATTENTION', message: 'Needs operator context' }] }],
        blocked: [{ taskId: 'task-blocked', displayId: 'DVF-0741', title: 'Blocked task', taskStatus: 'todo', reasons: [{ code: 'PREREQUISITE', message: 'Waiting for prerequisite' }] }],
      },
      truncated: { ready: false, execution: false, attention: false, blocked: false },
    },
    ...overrides,
  };
}

function renderOffice(props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(React.createElement(AgentOfficePage as any, {
    projectId: 'project-1',
    onOpenTask: () => {},
    disableAutoLoad: true,
    nowMs: Date.parse(generatedAt) + 10_000,
    ...props,
  }));
}

test('activity age and snapshot freshness helpers expose compact monitoring semantics', () => {
  assert.equal(formatActivityAge(null), 'age unknown');
  assert.equal(formatActivityAge(42_000), '42s');
  assert.equal(formatActivityAge(65_000), '1m');
  assert.equal(formatActivityAge(3_661_000), '1h 1m');
  assert.equal(isAgentOfficeSnapshotStale(generatedAt, Date.parse(generatedAt) + 10_000), false);
  assert.equal(isAgentOfficeSnapshotStale(generatedAt, Date.parse(generatedAt) + 16_000), true);
  assert.equal(isAgentOfficeSnapshotStale('invalid', Date.parse(generatedAt)), true);
});

test('Agent Office renders active workers, worker kind, pipeline and all canonical queues', () => {
  const html = renderOffice({ initialSnapshot: makeSnapshot() });

  assert.match(html, /Agent Office/);
  assert.match(html, /Monitoring only/);
  assert.match(html, /Active Agents/);
  assert.match(html, /Chat 0738/);
  assert.match(html, /DevFlow managed/);
  assert.match(html, />chat</);
  assert.match(html, /DVF-0738/);
  assert.match(html, /Implement monitoring UI/);
  assert.match(html, /Implementing/);
  assert.match(html, /1m/);
  assert.match(html, /DevFlow Pipeline/);
  assert.match(html, /Verifying 1/);
  assert.match(html, /Queues &amp; Attention/);
  assert.match(html, /Ready/);
  assert.match(html, /Execution/);
  assert.match(html, /Attention/);
  assert.match(html, /Blocked/);
  assert.match(html, /Needs operator context/);
  assert.match(html, /Waiting for prerequisite/);
});

test('Agent Office exposes explicit loading, empty, error and stale states', () => {
  const loadingHtml = renderToStaticMarkup(React.createElement(AgentOfficePage as any, {
    projectId: 'project-1',
    onOpenTask: () => {},
  }));
  assert.match(loadingHtml, /Loading Agent Office/);

  const emptySnapshot = makeSnapshot({
    workers: { total: 0, truncated: false, items: [] },
    pipeline: { total: 0, truncated: false, sourceTruncated: false, items: [] },
    queue: {
      counts: { ready: 0, execution: 0, attention: 0, blocked: 0 },
      items: { ready: [], execution: [], attention: [], blocked: [] },
      truncated: { ready: false, execution: false, attention: false, blocked: false },
    },
  });
  assert.match(renderOffice({ initialSnapshot: emptySnapshot }), /Agent Office is quiet/);
  assert.match(renderOffice({ initialError: 'backend unavailable' }), /Agent Office unavailable/);
  assert.match(renderOffice({ initialError: 'backend unavailable' }), /backend unavailable/);
  assert.match(renderOffice({ initialSnapshot: makeSnapshot(), nowMs: Date.parse(generatedAt) + 16_000 }), /Snapshot is stale/);
});

test('Agent Office routes monitored rows through the existing task drawer using GET-only reads', () => {
  const pageSource = fs.readFileSync('src/components/AgentOfficePage.tsx', 'utf8');
  const appSource = fs.readFileSync('src/App.tsx', 'utf8');
  const sidebarSource = fs.readFileSync('src/components/Sidebar.tsx', 'utf8');

  assert.match(pageSource, /onOpenTask\(worker\.taskId\)/);
  assert.match(pageSource, /onOpenTask\(row\.taskId\)/);
  assert.match(pageSource, /onOpenTask\(item\.taskId\)/);
  assert.doesNotMatch(pageSource, /apiPost|apiPut|apiDelete/);
  assert.doesNotMatch(pageSource, /onClick[^\n]*(pause|retry|reassign|reprioritize|reorder|kill)/i);

  const handlerStart = appSource.indexOf('const handleOpenAgentOfficeTask');
  const handlerEnd = appSource.indexOf('  if (!mounted)', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = appSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /fetchJson<Task>\('GET'/);
  assert.match(handler, /setSelectedTask\(result\.data\)/);
  assert.doesNotMatch(handler, /handleSetActivePage|apiPost|apiPut|apiDelete/);
  assert.match(appSource, /activePage === 'agent-office'/);
  assert.match(appSource, /#agent-office/);
  assert.match(sidebarSource, /Agent Office/);
  assert.match(sidebarSource, /onSetActivePage\?\.\('agent-office'\)/);
});
