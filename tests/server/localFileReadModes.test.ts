import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-local-read-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');

const { readFileSnippetsBatch, readLocalFile } = await import('../../src/server/services/localFileService.js');
const { clearFileReferences, resolveFileRef } = await import('../../src/server/services/fileReferenceService.js');
const { prepareCompactEdit } = await import('../../src/server/services/stenoEditProtocolService.js');
const { cleanupSessionWorkspace, createOrReuseSessionWorkspace, resetSessionWorkspaceRuntimeForTests } = await import('../../src/server/services/sessionWorkspaceService.js');

function runGit(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

const state: any = {
  projectsCache: [
    { id: 'project-read-1', name: 'Read Fixture', repoUrl: 'https://example.com/read', localPath: tempDir },
  ],
};
createProject(state.projectsCache[0]);

fs.writeFileSync(path.join(tempDir, 'sample.txt'), ['one', 'two', 'three', 'four'].join('\n'), 'utf8');
fs.writeFileSync(path.join(tempDir, 'other.txt'), ['alpha', 'beta', 'gamma'].join('\n'), 'utf8');
fs.mkdirSync(path.join(tempDir, 'nested', 'folder'), { recursive: true });
fs.writeFileSync(path.join(tempDir, 'nested', 'folder', 'slash.txt'), 'slash path', 'utf8');
fs.writeFileSync(path.join(tempDir, 'large-read.txt'), 'z'.repeat(12_000), 'utf8');
for (let index = 0; index < 8; index += 1) {
  fs.writeFileSync(path.join(tempDir, `batch-${index}.txt`), `batch-${index}-`.repeat(20), 'utf8');
}

test('readLocalFile can return a line window instead of the full file', () => {
  const result = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
    startLine: 2,
    endLine: 3,
  });

  assert.equal(result.content, 'two\nthree');
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 3);
  assert.equal(result.totalLines, 4);
  assert.equal(result.truncated, true);
});

test('readLocalFile can return metadata without content', () => {
  const result = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
    mode: 'metadata',
  });

  assert.equal(result.content, undefined);
  assert.equal(result.bytes, Buffer.byteLength('one\ntwo\nthree\nfour', 'utf8'));
  assert.equal(result.totalLines, 4);
});

test('readLocalFile accepts Windows-style separators and returns slash-normalized paths', () => {
  const result = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'nested\\\\folder\\\\slash.txt',
  });

  assert.equal(result.path, 'nested/folder/slash.txt');
  assert.equal(result.content, 'slash path');
});


test('readLocalFile returns revision metadata with content and metadata modes', () => {
  const contentResult = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
  });

  assert.equal(typeof contentResult.revision, 'string');
  assert.equal(contentResult.revision, contentResult.fileRevision.token);
  assert.equal(contentResult.fileRevision.size, Buffer.byteLength('one\ntwo\nthree\nfour', 'utf8'));
  assert.equal(typeof contentResult.fileRevision.sha256, 'string');

  const metadataResult = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
    mode: 'metadata',
  });

  assert.equal(metadataResult.revision, contentResult.revision);
  assert.equal(metadataResult.fileRevision.sha256, contentResult.fileRevision.sha256);
});

test('readFileSnippetsBatch returns multiple snippets with revision metadata', () => {
  const result = readFileSnippetsBatch(state, {
    projectId: 'project-read-1',
    files: [
      { filePath: 'sample.txt', startLine: 2, endLine: 3 },
      { path: 'other.txt', startLine: 1, endLine: 2 },
    ],
  });

  assert.equal(result.count, 2);
  assert.equal(result.requestedCount, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.files[0].content, 'two\nthree');
  assert.equal(result.files[1].content, 'alpha\nbeta');
  assert.equal(result.files[0].revision, result.files[0].fileRevision.token);
  assert.equal(result.files[1].revision, result.files[1].fileRevision.token);
});

test('readFileSnippetsBatch supports metadata entries', () => {
  const result = readFileSnippetsBatch(state, {
    projectId: 'project-read-1',
    files: [
      { filePath: 'sample.txt', mode: 'metadata' },
    ],
  });

  assert.equal(result.count, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.files[0].content, undefined);
  assert.equal(result.files[0].totalLines, 4);
  assert.equal(typeof result.files[0].fileRevision.sha256, 'string');
});

test('readFileSnippetsBatch bootstraps multiple Steno-ready refs in one bounded call', () => {
  clearFileReferences();
  const result = readFileSnippetsBatch(state, {
    projectId: 'project-read-1',
    includeFileRef: true,
    maxTotalBytes: 2_000,
    files: [
      { filePath: 'sample.txt' },
      { filePath: 'other.txt' },
      { filePath: 'nested/folder/slash.txt' },
    ],
  });

  assert.equal(result.count, 3);
  assert.equal(result.successCount, 3);
  assert.equal(result.errorCount, 0);
  assert.equal(result.partial, false);
  assert.equal(result.files.every((entry: any) => /^file-ref-/.test(entry.fileRef)), true);
  assert.equal(result.files.every((entry: any) => entry.revision === entry.fileRevision.token), true);
  assert.equal(result.totalReturnedBytes > 0, true);
  console.log(`[read-bootstrap] files=3 separateCalls=3 batchCalls=1 bytes=${result.totalReturnedBytes}`);
});

test('readFileSnippetsBatch can report partial per-file failures without dropping valid refs', () => {
  clearFileReferences();
  const result = readFileSnippetsBatch(state, {
    projectId: 'project-read-1',
    includeFileRef: true,
    allowPartial: true,
    files: [
      { filePath: 'sample.txt' },
      { filePath: 'missing.txt' },
      { filePath: 'other.txt' },
    ],
  });

  assert.equal(result.count, 3);
  assert.equal(result.successCount, 2);
  assert.equal(result.errorCount, 1);
  assert.equal(result.partial, true);
  assert.match(result.files[0].fileRef, /^file-ref-/);
  assert.equal(result.files[1].ok, false);
  assert.equal(result.files[1].path, 'missing.txt');
  assert.equal(result.files[1].error.code, 'FILE_NOT_FOUND');
  assert.match(result.files[2].fileRef, /^file-ref-/);
});

test('readFileSnippetsBatch enforces aggregate byte budget across 8 edit targets', () => {
  clearFileReferences();
  const result = readFileSnippetsBatch(state, {
    projectId: 'project-read-1',
    includeFileRef: true,
    allowPartial: true,
    maxTotalBytes: 256,
    files: Array.from({ length: 8 }, (_, index) => ({ filePath: `batch-${index}.txt` })),
  });

  assert.equal(result.requestedCount, 8);
  assert.equal(result.count, 8);
  assert.equal(result.totalReturnedBytes <= result.maxTotalBytes, true);
  assert.equal(result.truncated, true);
  assert.equal(result.files.some((entry: any) => entry.error?.code === 'BATCH_BYTE_LIMIT'), true);
  console.log(`[read-bootstrap] files=8 separateCalls=8 batchCalls=1 bytes=${result.totalReturnedBytes}/${result.maxTotalBytes}`);
});

test('readFileSnippetsBatch compact response mode caps large target content', () => {
  const result = readFileSnippetsBatch(state, {
    projectId: 'project-read-1',
    responseMode: 'compact',
    files: [{ filePath: 'large-read.txt' }],
  });
  assert.equal(result.files[0].responseMode, 'compact');
  assert.equal(result.files[0].truncated, true);
  assert.equal(result.files[0].returnedBytes < 5_000, true);
});

test('readLocalFile compact response mode caps content while retaining revision metadata', () => {
  const compact = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'large-read.txt',
    responseMode: 'compact',
  });
  const standard = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'large-read.txt',
    responseMode: 'standard',
  });

  assert.equal(compact.responseMode, 'compact');
  assert.equal(compact.truncated, true);
  assert.equal(compact.returnedBytes! < 5_000, true);
  assert.equal(compact.omittedBytes! > 0, true);
  assert.equal(compact.revision, compact.fileRevision.token);
  assert.equal(standard.responseMode, 'standard');
  assert.equal(standard.returnedBytes! > compact.returnedBytes!, true);
  assert.equal(compact.returnedBytes! / standard.returnedBytes! < 0.6, true);
});

test('readLocalFile can opt in to a revision-bound opaque fileRef', () => {
  clearFileReferences();
  const withoutRef = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
  });
  assert.equal(withoutRef.fileRef, undefined);

  const withRef = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
    includeFileRef: true,
  });

  assert.match(withRef.fileRef, /^file-ref-/);
  assert.equal(typeof withRef.fileRefExpiresAt, 'string');
  assert.equal(withRef.fileRefReused, false);
  const repeated = readLocalFile(state, {
    projectId: 'project-read-1',
    filePath: 'sample.txt',
    includeFileRef: true,
  });
  assert.equal(repeated.fileRef, withRef.fileRef);
  assert.equal(repeated.fileRefReused, true);
  const resolved = resolveFileRef(state, { projectId: 'project-read-1' }, withRef.fileRef);
  assert.equal(resolved.filePath, 'sample.txt');
  assert.equal(resolved.revision.sha256, withRef.fileRevision.sha256);
});

test('readFileSnippetsBatch keeps per-file reads and Steno refs inside a requested managed workspace', () => {
  clearFileReferences();
  const previousRuntimeDir = process.env.DEVFLOW_RUNTIME_DIR;
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-local-read-workspace-runtime-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-local-read-workspace-repo-'));
  process.env.DEVFLOW_RUNTIME_DIR = runtimeDir;
  resetSessionWorkspaceRuntimeForTests();

  runGit(repoRoot, ['init']);
  runGit(repoRoot, ['config', 'user.email', 'devflow@example.test']);
  runGit(repoRoot, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(repoRoot, 'workspace.txt'), 'project-root-copy', 'utf8');
  runGit(repoRoot, ['add', 'workspace.txt']);
  runGit(repoRoot, ['commit', '-m', 'workspace fixture']);

  const workspaceProject = {
    id: 'project-read-workspace',
    name: 'Read Workspace Fixture',
    repoUrl: 'https://example.com/read-workspace',
    localPath: repoRoot,
  };
  state.projectsCache.push(workspaceProject);
  createProject(workspaceProject);
  const workspace = createOrReuseSessionWorkspace(workspaceProject as any, 'batch-read-workspace');

  try {
    fs.writeFileSync(path.join(workspace.root, 'workspace.txt'), 'managed-workspace-copy', 'utf8');
    const result = readFileSnippetsBatch(state, {
      projectId: workspaceProject.id,
      workspaceId: workspace.workspaceId,
      includeFileRef: true,
      files: [{ filePath: 'workspace.txt' }],
    });

    assert.equal(result.root, workspace.root);
    assert.equal(result.files[0].root, workspace.root);
    assert.equal(result.files[0].content, 'managed-workspace-copy');
    assert.notEqual(result.files[0].content, 'project-root-copy');
    assert.match(result.files[0].fileRef, /^file-ref-/);

    const resolved = resolveFileRef(state, {
      projectId: workspaceProject.id,
      workspaceId: workspace.workspaceId,
    }, result.files[0].fileRef);
    assert.equal(resolved.filePath, 'workspace.txt');
    assert.equal(resolved.revision.sha256, result.files[0].fileRevision.sha256);

    const plan = prepareCompactEdit(state, {
      projectId: workspaceProject.id,
      workspaceId: workspace.workspaceId,
      v: 1,
      f: [[result.files[0].fileRef, [['R', 'managed-workspace-copy', 'managed-workspace-edited']]]],
      responseMode: 'compact',
    });
    assert.match(plan.editPlanId, /^edit-plan-/);
    assert.equal(plan.files[0].filePath, 'workspace.txt');
    assert.equal(plan.files[0].changed, true);
  } finally {
    runGit(workspace.root, ['checkout', '--', 'workspace.txt']);
    cleanupSessionWorkspace(workspace.workspaceId);
    state.projectsCache = state.projectsCache.filter((project: any) => project.id !== workspaceProject.id);
    resetSessionWorkspaceRuntimeForTests();
    if (previousRuntimeDir === undefined) delete process.env.DEVFLOW_RUNTIME_DIR;
    else process.env.DEVFLOW_RUNTIME_DIR = previousRuntimeDir;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
