import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskQuality } from '../../src/server/services/taskQualityService.js';

test('validateTaskQuality blocks implementation-ready Jira cards without implementation map', () => {
  const result = validateTaskQuality({
    title: '[QCA-3435] Fix Job Detail navigation bar overlap',
    status: 'todo',
    category: 'frontend',
    jiraKey: 'QCA-3435',
    description: 'Fix the Job Detail screen. Read Jira for details.',
    targetFiles: [],
    checklist: [{ id: 'step-1', text: 'Fix bug.', completed: false }],
    repoContext: 'Need to inspect repo.',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Implementation map/);
  assert.match(result.errors.join('\n'), /targetFiles/);
  assert.match(result.errors.join('\n'), /must not depend on Jira/);
});

test('validateTaskQuality blocks todo cards without explicit execution intent', () => {
  const result = validateTaskQuality({
    title: '[QCA-3436] Fix ready card that should still start in backlog',
    status: 'todo',
    category: 'frontend',
    targetFiles: ['JobDetailScreen.kt'],
    checklist: [{ id: 'step-1', text: 'Update the affected screen state mapping.', completed: false }],
    repoContext: [
      'Implementation map:',
      '- File: JobDetailScreen.kt',
      '  Class/function: JobDetailContent',
      '  Current behavior: old behavior.',
      '  Expected change: new behavior.',
    ].join('\n'),
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /default to backlog/);
});

test('validateTaskQuality warns when one card looks like hidden multi-slice work', () => {
  const result = validateTaskQuality({
    title: '[QCA-3437] Add warranty badge across data and UI',
    status: 'backlog',
    category: 'general',
    description: 'Add API DTO mapper repository support and render the new UI badge on the Job Detail screen.',
    targetFiles: ['JobDetailResponse.kt', 'JobDetailMapper.kt', 'JobDetailRepository.kt', 'JobDetailScreen.kt', 'JobDetailViewModel.kt', 'JobDetailScreenTest.kt'],
    checklist: [
      { id: 'step-1', text: 'Add DTO support.', completed: false },
      { id: 'step-2', text: 'Map repository data.', completed: false },
      { id: 'step-3', text: 'Expose UI state.', completed: false },
      { id: 'step-4', text: 'Render UI badge.', completed: false },
      { id: 'step-5', text: 'Add mapper tests.', completed: false },
      { id: 'step-6', text: 'Add screen tests.', completed: false },
      { id: 'step-7', text: 'Verify integration.', completed: false },
    ],
  });

  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /parent card plus focused child/);
});

test('validateTaskQuality accepts implementation-ready card with focused implementation map', () => {
  const result = validateTaskQuality({
    title: '[QCA-3435] Fix Job Detail navigation bar overlap',
    status: 'todo',
    category: 'frontend',
    jiraKey: 'QCA-3435',
    description: 'Fix Sub-team My Jobs survey Job Detail Details tab so Android navigation bar never covers lower content.',
    targetFiles: ['JobDetailScreen.kt', 'JobDetailFragment.kt'],
    checklist: [
      { id: 'step-1', text: 'Confirm the Details tab inset owner used by Job Detail.', completed: false },
      { id: 'step-2', text: 'Apply the smallest bottom system-bar inset fix for Details tab content.', completed: false },
    ],
    reasoning: 'User explicitly asked to queue/start implementation for this already reviewed card.',
    repoContext: [
      'Implementation map:',
      '- File: JobDetailScreen.kt',
      '  Class/function: JobDetailContent / DetailsTabContent',
      '  Current behavior: lower content can render under the Android navigation bar.',
      '  Expected change: apply bottom system-bar padding.',
      '- File: JobDetailFragment.kt',
      '  Class/function: edge-to-edge root inset setup',
      '  Current behavior: likely screen-level inset owner.',
      '  Expected change: adjust only if this host owns the inset.',
    ].join('\n'),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});
