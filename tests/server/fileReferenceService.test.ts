import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-file-ref-'));
const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-file-ref-other-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const {
  clearFileReferences,
  getFileReferenceStats,
  issueFileRef,
  resolveFileRef,
} = await import('../../src/server/services/fileReferenceService.js');

const state: any = {
  projectsCache: [
    { id: 'project-ref-a', name: 'Ref A', repoUrl: 'https://example.com/a', localPath: tempDir },
    { id: 'project-ref-b', name: 'Ref B', repoUrl: 'https://example.com/b', localPath: otherDir },
  ],
};

function write(root: string, name: string, content: string) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

function revision(targetPath: string) {
  const stat = fs.statSync(targetPath);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
  return {
    token: `${stat.size}:${Math.trunc(stat.mtimeMs)}:${sha256.slice(0, 16)}`,
    sha256,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function errorCode(error: unknown) {
  return (error as any)?.payload?.code;
}

test.beforeEach(() => {
  clearFileReferences();
});

test('fileRef binds project, canonical path and exact revision', () => {
  const targetPath = write(tempDir, 'src/example.txt', 'alpha');
  const issued = issueFileRef(state, { projectId: 'project-ref-a' }, {
    root: tempDir,
    targetPath,
    filePath: 'src/example.txt',
    revision: revision(targetPath),
    nowMs: 1_000,
  });

  assert.match(issued.fileRef, /^file-ref-[0-9a-f-]{20,}$/i);
  assert.equal(issued.expiresAtMs > issued.createdAtMs, true);

  const resolved = resolveFileRef(state, { projectId: 'project-ref-a' }, issued.fileRef, { nowMs: 2_000 });
  assert.equal(resolved.filePath, 'src/example.txt');
  assert.equal(path.resolve(resolved.targetPath), path.resolve(targetPath));
  assert.equal(resolved.revision.sha256, revision(targetPath).sha256);
});

test('fileRef rejects cross-project reuse and stale content', () => {
  const targetPath = write(tempDir, 'cross.txt', 'one');
  const issued = issueFileRef(state, { projectId: 'project-ref-a' }, {
    root: tempDir,
    targetPath,
    filePath: 'cross.txt',
    revision: revision(targetPath),
    nowMs: 1_000,
  });

  assert.throws(
    () => resolveFileRef(state, { projectId: 'project-ref-b' }, issued.fileRef, { nowMs: 2_000 }),
    (error: unknown) => errorCode(error) === 'EDIT_REF_PROJECT_MISMATCH',
  );

  write(tempDir, 'cross.txt', 'two');
  assert.throws(
    () => resolveFileRef(state, { projectId: 'project-ref-a' }, issued.fileRef, { nowMs: 2_000 }),
    (error: unknown) => errorCode(error) === 'EDIT_REF_STALE',
  );
});

test('fileRef becomes stale when its target file disappears after read', () => {
  const targetPath = write(tempDir, 'missing-after-read.txt', 'one');
  const issued = issueFileRef(state, { projectId: 'project-ref-a' }, {
    root: tempDir,
    targetPath,
    filePath: 'missing-after-read.txt',
    revision: revision(targetPath),
    nowMs: 1_000,
  });
  fs.unlinkSync(targetPath);

  assert.throws(
    () => resolveFileRef(state, { projectId: 'project-ref-a' }, issued.fileRef, { nowMs: 2_000 }),
    (error: unknown) => errorCode(error) === 'EDIT_REF_STALE',
  );
});

test('fileRef expiry is actionable and pruned refs may become not found', () => {
  const targetPath = write(tempDir, 'expiring.txt', 'one');
  const issued = issueFileRef(state, { projectId: 'project-ref-a' }, {
    root: tempDir,
    targetPath,
    filePath: 'expiring.txt',
    revision: revision(targetPath),
    nowMs: 1_000,
    ttlMs: 5_000,
  });

  assert.throws(
    () => resolveFileRef(state, { projectId: 'project-ref-a' }, issued.fileRef, { nowMs: 6_000 }),
    (error: unknown) => {
      assert.equal(errorCode(error), 'EDIT_REF_EXPIRED');
      assert.match(String((error as any)?.message || ''), /re-read/i);
      return true;
    },
  );

  assert.throws(
    () => resolveFileRef(state, { projectId: 'project-ref-a' }, issued.fileRef, { nowMs: 7_000 }),
    (error: unknown) => errorCode(error) === 'EDIT_REF_NOT_FOUND',
  );
});

test('fileRef registry remains bounded', () => {
  const targetPath = write(tempDir, 'bounded.txt', 'one');
  for (let index = 0; index < 300; index += 1) {
    issueFileRef(state, { projectId: 'project-ref-a' }, {
      root: tempDir,
      targetPath,
      filePath: 'bounded.txt',
      revision: revision(targetPath),
      nowMs: 1_000 + index,
    });
  }
  assert.equal(getFileReferenceStats().entries <= getFileReferenceStats().maxEntries, true);
});

test('fileRef rejects symlink targets that escape the canonical project root when symlinks are available', (t) => {
  const outside = write(otherDir, 'outside.txt', 'outside');
  const link = path.join(tempDir, 'escape.txt');
  try {
    fs.symlinkSync(outside, link, 'file');
  } catch {
    t.skip('symlink creation is unavailable in this environment');
    return;
  }

  assert.throws(
    () => issueFileRef(state, { projectId: 'project-ref-a' }, {
      root: tempDir,
      targetPath: link,
      filePath: 'escape.txt',
      revision: revision(link),
      nowMs: 1_000,
    }),
    (error: unknown) => errorCode(error) === 'UNSAFE_PATH',
  );
});

test.after(() => {
  clearFileReferences();
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(otherDir, { recursive: true, force: true });
});
