#!/usr/bin/env node
// Tests: POST /api/tasks/import-file (dry-run + apply)
// Run with DevFlow server on localhost:3000: npm test
// Uses fetch API directly for super-simple assertions

const BASE = process.env.DEVFLOW_URL || 'http://localhost:3000';

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function assert(condition, msg) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

async function main() {
  // 1. dry-run create + update
  const r1 = await post('/api/tasks/import-file', {
    mode: 'dry-run',
    patchFilePath: 'test-import-dry-run-sample.json',
  });
  assert(r1.status === 200, `dry-run status=${r1.status}`);
  assert(r1.body.summary.planned > 0, 'dry-run planned > 0');

  // 2. unknown field
  const r2 = await post('/api/tasks/import-file', {
    mode: 'dry-run',
    patchFilePath: 'test-import-unknown-field.json',
  });
  assert(r2.status === 200, `unknown field status=${r2.status}`);
  assert(r2.body.summary.failed > 0, 'unknown field rejected');

  // 3. malformed JSON
  const r3 = await post('/api/tasks/import-file', {
    mode: 'dry-run',
    patchFilePath: 'test-import-malformed.json',
  });
  assert(r3.status === 400, `malformed JSON status=${r3.status}`);

  // 4. path traversal
  const r4 = await post('/api/tasks/import-file', {
    mode: 'dry-run',
    patchFilePath: '../etc/passwd',
  });
  assert(r4.status === 400, `path traversal status=${r4.status}`);

  // 5. missing file
  const r5 = await post('/api/tasks/import-file', {
    mode: 'dry-run',
    patchFilePath: 'nonexistent-file.json',
  });
  assert(r5.status === 400, `missing file status=${r5.status}`);

  console.log('PASS: all import-file tests passed');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
