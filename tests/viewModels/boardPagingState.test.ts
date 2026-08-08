import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_PAGE_SIZE,
  getBoardLaneRefreshLimit,
  mergeBoardTaskPage,
  updateBoardLanePageState,
  type BoardLanePages,
} from '../../src/viewModels/useBoardViewModel.js';
import type { DomainTask } from '../../src/domain/mappers/taskMapper.js';

function task(id: string, status: string, extra: Partial<DomainTask> = {}): DomainTask {
  return { id, displayId: id, title: id, status, images: [], ...extra } as any;
}

function pages(): BoardLanePages {
  return {
    backlog: { total: 2, loaded: 2, hasMore: false, loading: false },
    todo: { total: 60, loaded: 25, hasMore: true, loading: false },
    'in-progress': { total: 4, loaded: 4, hasMore: false, loading: false },
    'ready-for-review': { total: 3, loaded: 3, hasMore: false, loading: false },
    done: { total: 40, loaded: 25, hasMore: true, loading: false },
  };
}

test('mergeBoardTaskPage deduplicates appended pages and preserves an optimistic pending move', () => {
  const previous = [task('a', 'todo'), task('b', 'in-progress', { activeAgent: 'codex' })];
  const incoming = [task('b', 'todo'), task('c', 'todo'), task('c', 'todo')];
  const merged = mergeBoardTaskPage(previous, incoming, new Set(['b']));

  assert.deepEqual(merged.map((item) => item.id).sort(), ['a', 'b', 'c']);
  assert.equal(merged.find((item) => item.id === 'b')?.status, 'in-progress');
  assert.equal(merged.find((item) => item.id === 'b')?.activeAgent, 'codex');
});

test('updateBoardLanePageState advances only the requested lane', () => {
  const previous = pages();
  const next = updateBoardLanePageState(previous, 'todo', {
    total: 60,
    itemCount: 25,
    hasMore: true,
    mode: 'append',
  });

  assert.equal(next.todo.loaded, 50);
  assert.equal(next.todo.total, 60);
  assert.equal(next.done, previous.done);
});

test('poll refresh stays bounded to the amount already loaded in each lane', () => {
  assert.equal(getBoardLaneRefreshLimit(0), BOARD_PAGE_SIZE);
  assert.equal(getBoardLaneRefreshLimit(25), 25);
  assert.equal(getBoardLaneRefreshLimit(50), 50);
});
