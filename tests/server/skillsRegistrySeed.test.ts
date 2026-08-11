import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-skills-seed-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();

const { initSkillsRepository, getSkills } = await import('../../src/server/repositories/skillsRepository.js');
const db = (await import('../../src/db/index.js')).default;
const express = (await import('express')).default;
const { registerSkillRoutes } = await import('../../src/server/routes/skills.js');

test('initSkillsRepository seeds all repo authoring skills when the database is empty', () => {
  initSkillsRepository();

  const authoringIds = getSkills()
    .map((skill: any) => skill.id)
    .filter((id: string) => id.startsWith('0'));

  assert.deepEqual(authoringIds.sort(), [
    '00-skill-router',
    '01-authoring-core',
    '02-schema-reference',
    '03-reviewer-core',
    '04-examples',
    '05-authoring-evidence',
    '06-authoring-decomposition',
    '07-authoring-execution',
    '08-board-loop-execution',
  ]);

  const authoringCore = getSkills().find((skill: any) => skill.id === '01-authoring-core');
  assert.ok(authoringCore);
  assert.ok(authoringCore.content.includes('DevFlow Authoring Core'));
  assert.equal(authoringCore.isProtected, true);
});

test('canonical master metadata replaces stale persisted descriptions', () => {
  db.prepare('UPDATE skills SET description = ? WHERE id = ?').run('Rules for reviewing DevFlow cards before they are ready for implementation.', '03-reviewer-core');

  initSkillsRepository();

  const reviewer = getSkills().find((skill: any) => skill.id === '03-reviewer-core');
  assert.ok(reviewer);
  assert.match(reviewer.description, /ready-for-review/i);
  assert.doesNotMatch(reviewer.description, /before they are ready for implementation/i);
});

test('master skills replace stale machine-specific source paths with repo-relative paths', () => {
  const stalePath = path.join(tempDir, 'old-machine', 'skills', '00-skill-router.md');
  db.prepare('UPDATE skills SET sourcePath = ? WHERE id = ?').run(stalePath, '00-skill-router');

  initSkillsRepository();

  const router = getSkills().find((skill: any) => skill.id === '00-skill-router');
  assert.ok(router);
  assert.equal(router.sourcePath, 'skills/00-skill-router.md');
  assert.equal(path.isAbsolute(router.sourcePath), false);
  assert.match(router.content, /DevFlow Skill Router/);
});

test('skill router keeps ambiguous DevFlow visual requests in DevFlow and makes image generation explicit opt-in', () => {
  initSkillsRepository();

  const router = getSkills().find((skill: any) => skill.id === '00-skill-router');
  assert.ok(router);

  assert.match(router.content, /preview UI|UI preview/i);
  assert.match(router.content, /mockup|mock up/i);
  assert.match(router.content, /concept/i);
  assert.match(router.content, /redesign|layout/i);
  assert.match(router.content, /DevFlow/i);
  assert.match(router.content, /image generation/i);
  assert.match(router.content, /explicit opt-in|explicitly asks|clear(?:ly)? asks/i);
});

test('authoring skills endpoint returns the repo skill set in file order', async () => {
  const app = express();
  registerSkillRoutes(app, { state: {}, writeAgentLog: () => {} } as any);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Server address unavailable');

  const response = await fetch(`http://127.0.0.1:${addr.port}/api/skills/authoring`);
  const body = await response.json() as any[];
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  assert.equal(response.status, 200);
  assert.deepEqual(body.map((skill: any) => skill.id), [
    '00-skill-router',
    '01-authoring-core',
    '02-schema-reference',
    '03-reviewer-core',
    '04-examples',
    '05-authoring-evidence',
    '06-authoring-decomposition',
    '07-authoring-execution',
    '08-board-loop-execution',
  ]);
});

test('authoring skill endpoint returns one requested repo skill', async () => {
  const app = express();
  registerSkillRoutes(app, { state: {}, writeAgentLog: () => {} } as any);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Server address unavailable');

  const response = await fetch(`http://127.0.0.1:${addr.port}/api/skills/authoring/00-skill-router`);
  const body = await response.json() as any;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  assert.equal(response.status, 200);
  assert.equal(body.id, '00-skill-router');
  assert.match(body.content, /Skill Router/);
});

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
