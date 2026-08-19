import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFromDevFlowAppRoot } from '../../src/lib/devFlowPaths.js';

const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-bootstrap-db-'));
process.env.DEVFLOW_DB_PATH = path.join(dbRoot, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTask } = await import('../../src/server/repositories/taskRepository.js');
const { createExecutionSession } = await import('../../src/server/services/executionSessionService.js');
const { sanitizeStartupTasks } = await import('../../src/server/bootstrap.js');

function startupTask(id: string, options: { parentId?: string; claim?: any } = {}) {
  const now = new Date().toISOString();
  return {
    id,
    displayId: id.toUpperCase(),
    title: id,
    description: 'Startup lifecycle sanitation regression fixture.',
    projectId: 'project-bootstrap-lifecycle',
    status: 'in-progress',
    priority: 'medium',
    branch: 'develop',
    tags: [],
    targetFiles: [`src/${id}.ts`],
    checklist: [],
    verificationEvidence: [],
    logs: [],
    bugs: [],
    images: [],
    designImages: [],
    parentId: options.parentId,
    claim: options.claim,
    createdAt: now,
    updatedAt: now,
  } as any;
}

// bootstrap.ts is an integration entrypoint - verify its path contract and startup sanitation.
test('resolveFromDevFlowAppRoot returns a path that includes the DevFlow app root', () => {
  const resolved = resolveFromDevFlowAppRoot('logs', 'agent-trigger.log');
  assert.match(resolved, /logs[\\\/]agent-trigger\.log$/);
});

test('resolveFromDevFlowAppRoot accepts a single segment', () => {
  const resolved = resolveFromDevFlowAppRoot('package.json');
  assert.match(resolved, /[\\\/]package\.json$/);
});

test('startup sanitation preserves authoritative lifecycle ownership and orchestration parents', () => {
  createProject({
    id: 'project-bootstrap-lifecycle',
    name: 'Bootstrap lifecycle',
    repoUrl: 'https://example.test/bootstrap-lifecycle',
    localPath: dbRoot,
  } as any);

  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const parent = startupTask('startup-parent');
  const claimedChild = startupTask('startup-claimed-child', {
    parentId: parent.id,
    claim: {
      workspaceId: 'ws-bootstrap-claimed',
      sessionIdHash: 'fixture-session',
      ownershipEpochId: 'epoch-bootstrap-claimed',
      ownerLabel: 'Chat bootstrap',
      ownerKind: 'chat',
      claimedAt: new Date().toISOString(),
      expiresAt,
    },
  });
  const executionOnly = startupTask('startup-execution-only');
  const staleLegacy = startupTask('startup-stale-legacy');
  for (const item of [parent, claimedChild, executionOnly, staleLegacy]) saveTask(item);

  createExecutionSession({
    projectId: claimedChild.projectId,
    taskId: claimedChild.id,
    workspaceId: claimedChild.claim.workspaceId,
    branch: 'develop',
    ownershipEpochId: claimedChild.claim.ownershipEpochId,
  });
  createExecutionSession({
    projectId: executionOnly.projectId,
    taskId: executionOnly.id,
    workspaceId: 'ws-bootstrap-execution-only',
    branch: 'develop',
    ownershipEpochId: 'epoch-bootstrap-execution-only',
  });

  sanitizeStartupTasks({} as any);

  assert.equal(getTask(claimedChild.id)?.status, 'in-progress');
  assert.equal(getTask(claimedChild.id)?.claim?.workspaceId, claimedChild.claim.workspaceId);
  assert.equal(getTask(executionOnly.id)?.status, 'in-progress');
  assert.equal(getTask(parent.id)?.status, 'in-progress');
  assert.equal(getTask(staleLegacy.id)?.status, 'todo');
});

test.after(() => {
  try { fs.rmSync(dbRoot, { recursive: true, force: true }); } catch {}
});
