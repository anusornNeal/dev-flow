import test from 'node:test';
import assert from 'node:assert/strict';
import { toTaskResponse } from '../../src/server/routes/taskRouteSupport.js';

test('board/search task payloads never serialize UI evidence or preview source even when a rich task object carries similarly named fields', () => {
  const task = {
    id: 'task-board-ui', displayId: 'DVF-BOARD-UI', title: 'Board UI', status: 'todo', priority: 'high', category: 'frontend', projectId: 'project-1',
    tags: [], targetFiles: [], checklist: [], images: [], createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:00:00.000Z',
    uiEvidence: [{ evidenceId: 'uie_secret', html: 'LEAK-ME' }],
    uiDesignEvidence: [{ evidenceId: 'uie_secret_2', css: 'LEAK-CSS' }],
    previewHtml: '<main>LEAK-SOURCE</main>',
  };

  for (const mode of ['minimal', 'summary', 'board'] as const) {
    const response = toTaskResponse(task, mode);
    const serialized = JSON.stringify(response);
    assert.equal('uiEvidence' in response, false);
    assert.equal('uiDesignEvidence' in response, false);
    assert.doesNotMatch(serialized, /uie_secret|LEAK-ME|LEAK-CSS|LEAK-SOURCE/);
  }
});
