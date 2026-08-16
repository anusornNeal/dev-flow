import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-server-events-publish-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'data', 'devflow.sqlite');
process.env.DEVFLOW_JOBS_DIR = path.join(tempRoot, '.devflow', 'jobs');
fs.mkdirSync(path.dirname(process.env.DEVFLOW_DB_PATH), { recursive: true });

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const events = await import('../../src/server/services/serverEventService.js') as any;
const projects = await import('../../src/server/repositories/projectRepository.js') as any;
const settings = await import('../../src/server/repositories/settingsRepository.js') as any;
const tasks = await import('../../src/server/repositories/taskRepository.js') as any;
const jobs = await import('../../src/server/repositories/mcpToolJobRepository.js') as any;
const atlas = await import('../../src/server/services/projectAtlasCacheService.js') as any;

function collectEvents() {
  const received: any[] = [];
  const subscription = events.subscribeServerEvents((event: any) => received.push(event));
  return { received, stop: () => subscription.unsubscribe() };
}

test.beforeEach(() => events.__resetServerEventsForTests());

test('central domain mutation boundaries publish compact invalidation events without secret values', () => {
  const { received, stop } = collectEvents();
  const projectId = `project-events-${Date.now()}`;
  const now = new Date().toISOString();
  const secret = 'do-not-stream-this-token';

  try {
    projects.createProject({
      id: projectId,
      name: 'Event Project',
      repoUrl: 'https://example.invalid/repo.git',
      localPath: tempRoot,
      createdAt: now,
    });
    settings.saveSettings({ jiraBaseUrl: 'https://example.invalid' });
    tasks.saveTask({
      id: `task-events-${Date.now()}`,
      displayId: 'EVT-0001',
      title: 'Publish event fixture',
      description: 'must never be copied into the event payload',
      projectId,
      status: 'todo',
      priority: 'medium',
      category: 'general',
      createdAt: now,
      updatedAt: now,
      repo: 'https://example.invalid/repo.git',
    });

    const job = jobs.createJob(
      `job-events-${Date.now()}`,
      'search_local_files',
      { projectId, query: 'needle', githubToken: secret },
      `repo:${tempRoot}`,
    );
    assert.ok(jobs.claimJob(job.jobId, 'event-worker', 30_000));
    assert.ok(jobs.transitionJobStatus(job.jobId, ['running'], { status: 'succeeded' }, { workerId: 'event-worker' }));

    const emptyAtlas = atlas.buildEmptyProjectAtlas({ projectId, generatedAt: now, scanMode: 'fast' });
    atlas.writeAtlasCache({ atlas: emptyAtlas, invalidationKind: 'source' });

    const types = received.map((event) => event.type);
    assert.ok(types.includes('project.changed'));
    assert.ok(types.includes('settings.changed'));
    assert.ok(types.includes('task.changed'));
    assert.ok(types.includes('job.changed'));
    assert.ok(types.includes('cache.invalidated'));
    assert.ok(types.includes('atlas.changed'));

    const jobStates = received.filter((event) => event.type === 'job.changed').map((event) => event.status);
    assert.deepEqual(jobStates, ['queued', 'running', 'succeeded']);

    const serialized = JSON.stringify(received);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('must never be copied into the event payload'), false);
    for (const event of received) {
      assert.ok(Object.keys(event).every((key) => ['v', 'id', 'type', 'at', 'projectId', 'entityId', 'status', 'reason'].includes(key)));
    }
  } finally {
    stop();
  }
});
