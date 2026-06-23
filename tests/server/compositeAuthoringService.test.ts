import { executeAllMigrations } from '../../src/db/migrations/index.js'; executeAllMigrations(); import db from '../../src/db/index.js'; db.prepare('INSERT OR IGNORE INTO projects (id, name, localPath) VALUES (?, ?, ?)').run('proj-1', 'Proj 1', '.'); process.env.JIRA_BASE_URL='http://test'; process.env.JIRA_EMAIL='test'; process.env.JIRA_API_TOKEN='test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { draftTaskFromJiraBundle } from '../../src/server/services/compositeAuthoringService.js';
import { getRepoInspectionIndex } from '../../src/server/services/repoInspectionIndexService.js';
import { DevFlowApiError } from '../../src/server/services/api.js';

test('draftTaskFromJiraBundle rejects with BUDGET_EXCEEDED when timeout is reached', async () => {
  const originalFetch = globalThis.fetch;
  
  // Set up mock state
  const state: any = {
    
    tasksCache: []
  };

  let signalReceived: AbortSignal | undefined;

  // Mock global fetch to delay response and capture AbortSignal
  globalThis.fetch = (async (url: string, options: any) => {
    signalReceived = options?.signal;
    
    return new Promise((resolve, reject) => {
      if (signalReceived?.aborted) {
        return reject(new DOMException('The user aborted a request.', 'AbortError'));
      }
      
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('The user aborted a request.', 'AbortError'));
      };
      
      if (signalReceived) {
        signalReceived.addEventListener('abort', onAbort);
      }

      const timer = setTimeout(() => {
        if (signalReceived) {
          signalReceived.removeEventListener('abort', onAbort);
        }
        resolve({
          ok: true,
          status: 200,
          json: async () => ({
            key: 'JIRA-100',
            fields: {
              summary: 'Failing test case',
              description: 'Will not complete in time'
            }
          })
        } as any);
      }, 1000); // 1 second delay, larger than budgetMs
    });
  }) as any;

  try {
    // Run with 50ms budget, which should trigger timeout abort
    await assert.rejects(async () => {
      await draftTaskFromJiraBundle(state, { jiraKey: 'JIRA-100', budgetMs: 50 });
    }, (err: any) => {
      return err instanceof DevFlowApiError && err.status === 408 && err.payload.code === 'BUDGET_EXCEEDED';
    });

    // Check that signal was passed down and is indeed aborted
    assert.ok(signalReceived);
    assert.equal(signalReceived.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getRepoInspectionIndex checks signal.aborted and throws error', async () => {
  const state: any = {
    projectsCache: [
      { id: 'proj-1', name: 'Proj 1', localPath: '.' }
    ]
  };

  const controller = new AbortController();
  controller.abort();

  assert.throws(() => {
    getRepoInspectionIndex(state, { projectId: 'proj-1' }, controller.signal);
  }, (err: any) => {
    return err instanceof Error && err.message === 'Operation aborted';
  });
});

test('draftTaskFromJiraBundle returns a create_task-compatible category', async () => {
  const originalFetch = globalThis.fetch;
  const state: any = {
    
    tasksCache: []
  };

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      key: 'JIRA-101',
      fields: {
        summary: 'Gateway authoring',
        description: 'Create a gateway authoring draft'
      }
    })
  })) as any;

  try {
    const result = await draftTaskFromJiraBundle(state, { jiraKey: 'JIRA-101' });
    assert.equal(result.draftPayload.category, 'general');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
