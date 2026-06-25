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
  ]);

  const authoringCore = getSkills().find((skill: any) => skill.id === '01-authoring-core');
  assert.ok(authoringCore);
  assert.ok(authoringCore.content.includes('DevFlow Authoring Core'));
  assert.equal(authoringCore.isProtected, true);
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
