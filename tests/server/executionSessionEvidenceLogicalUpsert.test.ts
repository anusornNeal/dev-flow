import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-execution-evidence-logical-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
const { withDbTransaction } = await import('../../src/db/index.js');
executeAllMigrations();
const repository = await import('../../src/server/repositories/executionSessionRepository.js');

function createSession(id: string) {
  const now = new Date().toISOString();
  return repository.createExecutionSessionRecord({
    id,
    projectId: 'project-logical-evidence',
    taskId: 'task-logical-evidence',
    workspaceId: 'ws_logical-evidence',
    branch: 'test/logical-evidence',
    baseRevision: 'base-revision',
    repoRevision: 'repo-revision',
    status: 'active',
    contextHandle: 'ctx-logical-evidence',
    changedFiles: [],
    verification: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    endedAt: null,
  });
}

test('execution evidence converges on the existing row for an equivalent logical key', () => {
  const session = createSession(`exec-logical-${Date.now()}`);
  const now = new Date().toISOString();
  const first = repository.saveExecutionSessionEvidence({
    id: `evidence-logical-a-${session.id}`,
    sessionId: session.id,
    kind: 'owned-change',
    path: 'src/A.ts',
    repoRevision: session.repoRevision,
    fileRevision: 'file-revision-1',
    revisionIdentity: 'logical-revision-1',
    contextHandle: session.contextHandle,
    stale: false,
    metadata: { source: 'logical-upsert-regression' },
    createdAt: now,
    updatedAt: now,
  });

  const second = repository.saveExecutionSessionEvidence({
    ...first,
    id: `evidence-logical-b-${session.id}`,
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
  });

  assert.equal(second.id, first.id);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(repository.listExecutionSessionEvidence(session.id).filter((entry) => entry.kind === 'owned-change' && entry.path === 'src/A.ts').length, 1);
});

test('execution evidence rejects an incompatible occupant of the same non-null logical key with a structured conflict', () => {
  const session = createSession(`exec-logical-conflict-${Date.now()}`);
  const now = new Date().toISOString();
  repository.saveExecutionSessionEvidence({
    id: `evidence-logical-conflict-a-${session.id}`,
    sessionId: session.id,
    kind: 'owned-change',
    path: 'src/B.ts',
    repoRevision: session.repoRevision,
    fileRevision: 'file-revision-a',
    revisionIdentity: 'logical-revision-a',
    contextHandle: session.contextHandle,
    stale: false,
    metadata: { source: 'logical-conflict-a' },
    createdAt: now,
    updatedAt: now,
  });

  assert.throws(() => repository.saveExecutionSessionEvidence({
    id: `evidence-logical-conflict-b-${session.id}`,
    sessionId: session.id,
    kind: 'owned-change',
    path: 'src/B.ts',
    repoRevision: session.repoRevision,
    fileRevision: 'file-revision-b',
    revisionIdentity: 'logical-revision-b',
    contextHandle: session.contextHandle,
    stale: false,
    metadata: { source: 'logical-conflict-b' },
    createdAt: now,
    updatedAt: now,
  }), (error: any) => error?.code === 'EXECUTION_SESSION_EVIDENCE_LOGICAL_CONFLICT');
});

test('nullable logical-key fields preserve SQLite uniqueness semantics for lifecycle history', () => {
  const session = createSession(`exec-null-logical-${Date.now()}`);
  const now = new Date().toISOString();
  repository.saveExecutionSessionEvidence({
    id: `lifecycle-null-a-${session.id}`,
    sessionId: session.id,
    kind: 'lifecycle-transition',
    path: null,
    repoRevision: session.repoRevision,
    fileRevision: null,
    revisionIdentity: 'transition-a',
    contextHandle: null,
    stale: false,
    metadata: { toStage: 'created' },
    createdAt: now,
    updatedAt: now,
  });
  repository.saveExecutionSessionEvidence({
    id: `lifecycle-null-b-${session.id}`,
    sessionId: session.id,
    kind: 'lifecycle-transition',
    path: null,
    repoRevision: session.repoRevision,
    fileRevision: null,
    revisionIdentity: 'transition-b',
    contextHandle: null,
    stale: false,
    metadata: { toStage: 'context-ready' },
    createdAt: now,
    updatedAt: now,
  });

  assert.equal(repository.listExecutionSessionEvidence(session.id).filter((entry) => entry.kind === 'lifecycle-transition').length, 2);
});

test('equivalent occupied logical evidence wins when an existing physical id moves into that slot', () => {
  const session = createSession(`exec-physical-move-${Date.now()}`);
  const now = new Date().toISOString();
  const moving = repository.saveExecutionSessionEvidence({
    id: `evidence-moving-${session.id}`,
    sessionId: session.id,
    kind: 'owned-change',
    path: 'src/A.ts',
    repoRevision: session.repoRevision,
    fileRevision: 'file-old',
    revisionIdentity: 'revision-current',
    contextHandle: 'ctx-old',
    stale: false,
    metadata: { source: 'old-context' },
    createdAt: now,
    updatedAt: now,
  });
  const occupied = repository.saveExecutionSessionEvidence({
    id: `evidence-occupied-${session.id}`,
    sessionId: session.id,
    kind: 'owned-change',
    path: 'src/A.ts',
    repoRevision: session.repoRevision,
    fileRevision: 'file-current',
    revisionIdentity: 'revision-current',
    contextHandle: session.contextHandle,
    stale: false,
    metadata: { source: 'current-context' },
    createdAt: now,
    updatedAt: now,
  });

  const resolved = repository.saveExecutionSessionEvidence({
    ...moving,
    contextHandle: session.contextHandle,
    fileRevision: 'file-current',
    metadata: { source: 'reconciled-context' },
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
  });

  assert.equal(resolved.id, occupied.id);
  assert.deepEqual(resolved.metadata, { source: 'reconciled-context' });
  assert.equal(repository.getExecutionSessionEvidenceById(moving.id)?.contextHandle, 'ctx-old');
});

test('structured logical conflict rolls back surrounding lifecycle state mutation', () => {
  const session = createSession(`exec-rollback-${Date.now()}`);
  const now = new Date().toISOString();
  const moving = repository.saveExecutionSessionEvidence({
    id: `evidence-rollback-moving-${session.id}`,
    sessionId: session.id,
    kind: 'owned-change',
    path: 'src/B.ts',
    repoRevision: session.repoRevision,
    fileRevision: 'file-old',
    revisionIdentity: 'revision-old',
    contextHandle: 'ctx-old',
    stale: false,
    metadata: { source: 'rollback-old' },
    createdAt: now,
    updatedAt: now,
  });
  repository.saveExecutionSessionEvidence({
    id: `evidence-rollback-occupied-${session.id}`,
    sessionId: session.id,
    kind: 'owned-change',
    path: 'src/B.ts',
    repoRevision: session.repoRevision,
    fileRevision: 'file-current',
    revisionIdentity: 'revision-current',
    contextHandle: session.contextHandle,
    stale: false,
    metadata: { source: 'rollback-current' },
    createdAt: now,
    updatedAt: now,
  });

  assert.throws(() => withDbTransaction(() => {
    repository.updateExecutionSessionRecord(session.id, { repoRevision: 'advanced-revision', updatedAt: new Date(Date.now() + 1_000).toISOString() });
    repository.saveExecutionSessionEvidence({
      ...moving,
      contextHandle: session.contextHandle,
      fileRevision: 'file-conflicting',
      revisionIdentity: 'revision-conflicting',
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    });
  }), (error: any) => error?.code === 'EXECUTION_SESSION_EVIDENCE_LOGICAL_CONFLICT');

  assert.equal(repository.getExecutionSessionById(session.id)?.repoRevision, session.repoRevision);
});
