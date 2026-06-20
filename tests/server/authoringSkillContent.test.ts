import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const authoringCore = fs.readFileSync(path.resolve('skills/01-authoring-core.md'), 'utf8');

test('authoring core requires targeted repo inspection and implementation maps', () => {
  assert.match(authoringCore, /Bounded repo inspection/);
  assert.match(authoringCore, /Implementation map/);
  assert.match(authoringCore, /classes, composables, functions, methods, helpers, routes, mappers, or tests/);
  assert.match(authoringCore, /Do not scan or read the whole repo/);
});
