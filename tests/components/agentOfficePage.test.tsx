import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentOfficePage, {
  advanceActivityAge,
  createAgentOfficeRefreshGate,
  describeAgentOfficeHealth,
  formatActivityAge,
  isAgentOfficeSnapshotStale,
} from '../../src/components/AgentOfficePage.js';
import type { AgentOfficeProjection } from '../../src/client/apiClient.js';

const generatedAt = '2026-08-26T10:00:00.000Z';
const sourcePage = { total: 2, returned: 2, limit: 100, truncated: false };

function makeSnapshot(overrides: Partial<AgentOfficeProjection> = {}): AgentOfficeProjection {
  return {
    schema: 'agent-office-monitor.v1',
    scope: 'global',
    projectId: null,
    generatedAt,
    limit: 20,
    partial: false,
    projects: {
      total: 2,
      items: [
        { projectId: 'project-a', projectName: 'Board Alpha' },
        { projectId: 'project-b', projectName: 'Board Beta' },
      ],
    },
    sources: {
      tasks: sourcePage,
      activeExecutions: sourcePage,
      checkpoints: sourcePage,
    },
    workers: {
      total: 1,
      truncated: false,
      sourceTruncated: false,
      items: [{
        projectId: 'project-a',
        projectName: 'Board Alpha',
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
        projectId: 'project-b',
        projectName: 'Board Beta',
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
        ready: [{ projectId: 'project-a', projectName: 'Board Alpha', taskId: 'task-ready', displayId: 'DVF-0740', title: 'Ready task', taskStatus: 'todo', reasons: [] }],
        execution: [{ projectId: 'project-b', projectName: 'Board Beta', taskId: 'task-execution', displayId: 'DVF-0738', title: 'Running task', taskStatus: 'in-progress', reasons: [] }],
        attention: [{ projectId: 'project-b', projectName: 'Board Beta', taskId: 'task-attention', displayId: 'DVF-0739', title: 'Needs attention', taskStatus: 'in-progress', reasons: [{ code: 'ATTENTION', message: 'Needs operator context' }] }],
        blocked: [{ projectId: 'project-a', projectName: 'Board Alpha', taskId: 'task-blocked', displayId: 'DVF-0741', title: 'Blocked task', taskStatus: 'todo', reasons: [{ code: 'PREREQUISITE', message: 'Waiting for prerequisite' }] }],
      },
      truncated: { ready: false, execution: false, attention: false, blocked: false },
      sourceTruncated: false,
      partial: false,
    },
    ...overrides,
  };
}

function renderOffice(props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(React.createElement(AgentOfficePage as any, {
    onOpenTask: () => {},
    disableAutoLoad: true,
    nowMs: Date.parse(generatedAt) + 10_000,
    ...props,
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test('activity age and snapshot freshness helpers expose compact monitoring semantics', () => {
  assert.equal(formatActivityAge(null), 'age unknown');
  assert.equal(formatActivityAge(42_000), '42s');
  assert.equal(formatActivityAge(65_000), '1m');
  assert.equal(formatActivityAge(3_661_000), '1h 1m');
  assert.equal(advanceActivityAge(65_000, generatedAt, Date.parse(generatedAt) + 10_000), 75_000);
  assert.equal(isAgentOfficeSnapshotStale(generatedAt, Date.parse(generatedAt) + 10_000), false);
  assert.equal(isAgentOfficeSnapshotStale(generatedAt, Date.parse(generatedAt) + 16_000), true);
  assert.equal(isAgentOfficeSnapshotStale('invalid', Date.parse(generatedAt)), true);
});

test('health semantics prioritize refresh failure, partial, stale and fallback while staying quiet when healthy', () => {
  assert.equal(describeAgentOfficeHealth({
    error: null,
    partialSnapshot: false,
    staleSnapshot: false,
    connectionState: 'connected',
  }), null);

  const fallback = describeAgentOfficeHealth({
    error: null,
    partialSnapshot: false,
    staleSnapshot: false,
    connectionState: 'fallback',
  });
  assert.equal(fallback?.title, 'Live updates interrupted');
  assert.match(fallback?.detail || '', /fallback refresh/i);

  const stale = describeAgentOfficeHealth({
    error: null,
    partialSnapshot: false,
    staleSnapshot: true,
    connectionState: 'connected',
  });
  assert.equal(stale?.title, 'Snapshot is stale');
  assert.match(stale?.detail || '', /out of date/i);

  const partial = describeAgentOfficeHealth({
    error: null,
    partialSnapshot: true,
    staleSnapshot: true,
    connectionState: 'connected',
  });
  assert.equal(partial?.title, 'Snapshot is partial');
  assert.match(partial?.detail || '', /counts and empty states may be incomplete/i);
  assert.match(partial?.detail || '', /also stale/i);

  const failed = describeAgentOfficeHealth({
    error: 'backend unavailable',
    partialSnapshot: true,
    staleSnapshot: true,
    connectionState: 'fallback',
  });
  assert.equal(failed?.title, 'Refresh failed');
  assert.equal(failed?.tone, 'danger');
  assert.match(failed?.detail || '', /last successful snapshot/i);
});

test('Agent Office renders operational hierarchy across active work, attention, queues and pipeline', () => {
  const html = renderOffice({ initialSnapshot: makeSnapshot() });

  assert.match(html, /Agent Office/);
  assert.match(html, /Global operational view across all projects/);
  assert.match(html, /aria-label="Agent Office summary"/);
  assert.match(html, /Active work/);
  assert.match(html, /Needs attention/);
  assert.match(html, /Blocked/);
  assert.match(html, /Ready to start/);
  assert.match(html, /Running queue/);
  assert.match(html, /Chat 0738/);
  assert.match(html, /DevFlow managed/);
  assert.match(html, />chat</);
  assert.match(html, /Board Alpha/);
  assert.match(html, /Board Beta/);
  assert.match(html, /DVF-0738/);
  assert.match(html, /Implement monitoring UI/);
  assert.match(html, /Implementing/);
  assert.match(html, /1m/);
  assert.match(html, />Pipeline</);
  assert.match(html, /Running checks 1/);
  assert.match(html, /Needs operator context/);
  assert.match(html, /Waiting for prerequisite/);
  assert.match(html, /Snapshot technical details/);
  assert.doesNotMatch(html, /Snapshot is stale/);
  assert.doesNotMatch(html, /Snapshot is partial/);
});

test('Agent Office exposes honest loading, empty, error, stale, partial and last-success failure states', () => {
  const loadingHtml = renderToStaticMarkup(React.createElement(AgentOfficePage as any, {
    onOpenTask: () => {},
  }));
  assert.match(loadingHtml, /Loading Agent Office/);
  assert.match(loadingHtml, /role="status"/);

  const emptySnapshot = makeSnapshot({
    workers: { total: 0, truncated: false, sourceTruncated: false, items: [] },
    pipeline: { total: 0, truncated: false, sourceTruncated: false, items: [] },
    queue: {
      counts: { ready: 0, execution: 0, attention: 0, blocked: 0 },
      items: { ready: [], execution: [], attention: [], blocked: [] },
      truncated: { ready: false, execution: false, attention: false, blocked: false },
      sourceTruncated: false,
      partial: false,
    },
  });
  assert.match(renderOffice({ initialSnapshot: emptySnapshot }), /Agent Office is quiet/);

  const partialEmpty = { ...emptySnapshot, partial: true };
  const partialZeroHtml = renderOffice({ initialSnapshot: partialEmpty });
  assert.match(partialZeroHtml, /Office state is incomplete/);
  assert.doesNotMatch(partialZeroHtml, /Agent Office is quiet/);

  const staleZeroHtml = renderOffice({ initialSnapshot: emptySnapshot, nowMs: Date.parse(generatedAt) + 16_000 });
  assert.match(staleZeroHtml, /Snapshot is stale/);
  assert.match(staleZeroHtml, /Office state is incomplete/);
  assert.doesNotMatch(staleZeroHtml, /Agent Office is quiet/);

  const partialBusyHtml = renderOffice({ initialSnapshot: makeSnapshot({ partial: true }) });
  assert.match(partialBusyHtml, /Snapshot is partial/);
  assert.match(partialBusyHtml, /counts and empty states may be incomplete/);

  const unavailableHtml = renderOffice({ initialError: 'backend unavailable' });
  assert.match(unavailableHtml, /Agent Office unavailable/);
  assert.match(unavailableHtml, /backend unavailable/);

  const staleHtml = renderOffice({ initialSnapshot: makeSnapshot(), nowMs: Date.parse(generatedAt) + 16_000 });
  assert.match(staleHtml, /Snapshot is stale/);
  assert.match(staleHtml, /Displayed work may be out of date/);

  const lastSuccessHtml = renderOffice({ initialSnapshot: makeSnapshot(), initialError: 'refresh endpoint unavailable' });
  assert.match(lastSuccessHtml, /Refresh failed/);
  assert.match(lastSuccessHtml, /Showing the last successful snapshot/);
  assert.match(lastSuccessHtml, /refresh endpoint unavailable/);
});

test('Agent Office keeps long blocked worker, pipeline and reason text inside operational cards', () => {
  const snapshot = makeSnapshot();
  const longOwner = 'Chat worker with an intentionally very long owner label that must remain inside the active work card';
  const longTitle = 'A very long task title from the server that should remain readable and discoverable without forcing the Agent Office card beyond its grid column';
  const longAction = 'Resolving a long-running recovery operation with detailed server activity that needs two safe wrapped lines rather than horizontal overflow';
  const longPipelineActivity = 'Post-integration verification is blocked while a very long diagnostic condition is being reconciled and the complete activity remains discoverable';
  const longReason = 'Waiting for a prerequisite with an intentionally verbose server explanation that must wrap safely inside the blocked queue card.';

  snapshot.workers.items[0] = {
    ...snapshot.workers.items[0],
    ownerLabel: longOwner,
    title: longTitle,
    action: longAction,
    indicator: 'blocked',
  };
  snapshot.pipeline.items[0] = {
    ...snapshot.pipeline.items[0],
    blocked: true,
    activity: longPipelineActivity,
  };
  snapshot.queue.items.blocked[0] = {
    ...snapshot.queue.items.blocked[0],
    title: longTitle,
    reasons: [{ code: 'BLOCKED', message: longReason }],
  };

  const html = renderOffice({ initialSnapshot: snapshot });
  assert.match(html, /min-w-0/);
  assert.match(html, /line-clamp-2 break-words/);
  assert.match(html, new RegExp(`title="${longOwner}"`));
  assert.match(html, new RegExp(`title="DVF-0738 · ${longTitle}"`));
  assert.match(html, new RegExp(`title="${longAction} · Implementing"`));
  assert.match(html, new RegExp(`title="${longPipelineActivity}"`));
  assert.match(html, new RegExp(`title="${longReason}"`));
  assert.match(html, />Blocked</);
  assert.match(html, /Blocked · Running checks/);
  assert.match(html, /text-\[var\(--df-color-danger\)\]/);
});

test('refresh gate is single-flight and coalesces invalidations during a request into one follow-up', async () => {
  const pending: Array<ReturnType<typeof deferred<string>>> = [];
  const snapshots: string[] = [];
  let calls = 0;
  const gate = createAgentOfficeRefreshGate<string>({
    fetchSnapshot: () => {
      calls += 1;
      const next = deferred<string>();
      pending.push(next);
      return next.promise;
    },
    isVisible: () => true,
    onSnapshot: (value) => snapshots.push(value),
    onError: (error) => { throw error; },
  });

  const first = gate.request(false);
  void gate.invalidate();
  void gate.invalidate();
  assert.equal(calls, 1);
  assert.equal(gate.isDirty(), true);
  pending[0].resolve('first');
  await first;
  await Promise.resolve();
  assert.equal(calls, 2, 'burst during the active request should create exactly one follow-up');
  pending[1].resolve('second');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(snapshots, ['first', 'second']);
  assert.equal(gate.isDirty(), false);
  gate.dispose();
});

test('refresh gate defers hidden-tab invalidation and reconciles once visibility returns', async () => {
  let visible = false;
  let calls = 0;
  const next = deferred<string>();
  const snapshots: string[] = [];
  const gate = createAgentOfficeRefreshGate<string>({
    fetchSnapshot: () => { calls += 1; return next.promise; },
    isVisible: () => visible,
    onSnapshot: (value) => snapshots.push(value),
    onError: (error) => { throw error; },
  });

  await gate.invalidate();
  assert.equal(calls, 0);
  assert.equal(gate.isDirty(), true);
  visible = true;
  const restored = gate.visibilityRestored();
  assert.equal(calls, 1);
  next.resolve('visible');
  await restored;
  assert.deepEqual(snapshots, ['visible']);
  gate.dispose();
});

test('refresh gate aborts disposal and ignores late responses after unmount', async () => {
  const next = deferred<string>();
  let signal: AbortSignal | null = null;
  const snapshots: string[] = [];
  const errors: unknown[] = [];
  const gate = createAgentOfficeRefreshGate<string>({
    fetchSnapshot: (requestSignal) => { signal = requestSignal; return next.promise; },
    isVisible: () => true,
    onSnapshot: (value) => snapshots.push(value),
    onError: (error) => errors.push(error),
  });

  const request = gate.request(false);
  gate.dispose();
  assert.equal(signal?.aborted, true);
  next.resolve('late');
  await request;
  assert.deepEqual(snapshots, []);
  assert.deepEqual(errors, []);
});

test('Agent Office uses global SSE invalidation, bounded fallback and no active-board or 5-second polling dependency', () => {
  const pageSource = fs.readFileSync('src/components/AgentOfficePage.tsx', 'utf8');
  const apiSource = fs.readFileSync('src/client/apiClient.ts', 'utf8');
  const appSource = fs.readFileSync('src/App.tsx', 'utf8');

  assert.match(pageSource, /startReactiveServerRefresh/);
  assert.match(pageSource, /GLOBAL_RUNTIME_INVALIDATION_EVENT_TYPES/);
  assert.match(pageSource, /FALLBACK_REFRESH_MS = 60_000/);
  assert.match(pageSource, /visibilitychange/);
  assert.match(pageSource, /AbortController/);
  assert.match(pageSource, /createAgentOfficeRefreshGate/);
  assert.match(pageSource, /onUnavailable/);
  assert.match(pageSource, /onAvailable/);
  assert.doesNotMatch(pageSource, /REFRESH_INTERVAL_MS/);
  assert.doesNotMatch(pageSource, /setInterval\([^;\n]*5_000/);
  assert.doesNotMatch(appSource, /<AgentOfficePage\s+projectId=/);
  assert.match(appSource, /<AgentOfficePage\s+onOpenTask=/);
  assert.match(apiSource, /getAgentOfficeProjection\(limit = 20/);
  assert.doesNotMatch(apiSource, /URLSearchParams\(\{\s*projectId/);
});


