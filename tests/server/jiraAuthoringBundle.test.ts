import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJiraAuthoringBundle } from '../../src/server/services/jiraAuthoringBundleService.js';

function jiraDoc(text: string) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

test('buildJiraAuthoringBundle returns compact Jira card authoring packet', async () => {
  process.env.JIRA_BASE_URL = 'http://test'; process.env.JIRA_EMAIL = 'test'; process.env.JIRA_API_TOKEN = 'test'; const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    assert.match(url, /\/rest\/api\/3\/issue\/QCA-3435/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        key: 'QCA-3435',
        self: 'https://jira.example/rest/api/3/issue/10001',
        fields: {
          summary: '[Android][Sub-team][Job Detail] bottom content covered by nav bar',
          description: jiraDoc('Fix Details tab so Android navigation bar never covers lower content.'),
          issuetype: { name: 'Bug' },
          priority: { name: 'Medium' },
          status: { name: 'To Do' },
          labels: ['Android'],
          components: [{ name: 'My Jobs' }],
          environment: jiraDoc('Vivo Y27 5G, Android 15, SIT 2.0.117'),
          comment: {
            comments: [
              { author: { displayName: 'QA' }, body: jiraDoc('Retest passed on SIT 2.0.118; verify branch before changing.') },
            ],
          },
          attachment: [
            { id: 'att-1', filename: 'nav-bar-overlap.png', mimeType: 'image/png', size: 1234 },
          ],
          subtasks: [{ key: 'QCA-3267', fields: { summary: 'Sibling details tab task', status: { name: 'Done' } } }],
          issuelinks: [
            { outwardIssue: { key: 'QCA-3259', fields: { summary: 'Parent survey Job Detail', status: { name: 'In Progress' } } } },
          ],
          parent: { key: 'QCA-3188', fields: { summary: 'Job Flow' } },
        },
      }),
    } as any;
  };

  const state: any = {
    
    tasksCache: [
      { id: 'task-1', displayId: 'DVF-1', title: 'Existing card', jiraKey: 'QCA-3435', status: 'backlog' },
    ],
  };

  const bundle = await buildJiraAuthoringBundle(state, { jiraKey: 'QCA-3435' }, fetchImpl as any);

  assert.equal(calls.length, 1);
  assert.equal(bundle.jira.key, 'QCA-3435');
  assert.match(bundle.jira.descriptionText, /Details tab/);
  assert.match(bundle.jira.environmentText, /Android 15/);
  assert.equal(bundle.comments.length, 1);
  assert.match(bundle.comments[0].bodyText, /Retest passed/);
  assert.deepEqual(bundle.attachments.map((entry: any) => entry.filename), ['nav-bar-overlap.png']);
  assert.deepEqual(bundle.relatedIssues.map((entry: any) => entry.key).sort(), ['QCA-3188', 'QCA-3259', 'QCA-3267']);
  assert.equal(bundle.existingDevFlowTasks[0].displayId, 'DVF-1');
  assert.match(bundle.authoringHints.join('\n'), /get_repo_inspection_index/);
  assert.match(bundle.nextSteps.join('\n'), /validate_task_quality/);
});

test('buildJiraAuthoringBundle reports missing Jira configuration clearly', async () => {
  process.env.JIRA_BASE_URL = ''; process.env.JIRA_EMAIL = ''; process.env.JIRA_API_TOKEN = '';
  await assert.rejects(
    () => buildJiraAuthoringBundle({  tasksCache: [] } as any, { jiraKey: 'QCA-1' }),
    /Jira configuration is incomplete/,
  );
});
