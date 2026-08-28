import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CustomSelect, resolveCustomSelectKeyAction } from '../../src/components/CustomSelect.js';

const noop = () => {};

const options = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'ready-for-review', label: 'Ready for Review' },
];

test('custom select exposes native trigger semantics and semantic foundation classes', () => {
  const html = renderToStaticMarkup(React.createElement(CustomSelect, {
    value: 'in-progress',
    onChange: noop,
    options,
    ariaLabel: 'Task status',
  }));

  assert.match(html, /<button/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Task status"/);
  assert.match(html, /df-select-trigger/);
  assert.match(html, /In Progress/);
});

test('disabled custom select is a real disabled control rather than pointer-events styling', () => {
  const html = renderToStaticMarkup(React.createElement(CustomSelect, {
    value: 'backlog',
    onChange: noop,
    options,
    disabled: true,
  }));

  assert.match(html, /disabled=""/);
  assert.match(html, /aria-disabled="true"/);
});

test('custom select keyboard action resolver covers opening, navigation, selection, and dismissal', () => {
  assert.deepEqual(resolveCustomSelectKeyAction('ArrowDown', -1, options.length, false), { type: 'open', index: 0 });
  assert.deepEqual(resolveCustomSelectKeyAction('ArrowUp', -1, options.length, false), { type: 'open', index: 2 });
  assert.deepEqual(resolveCustomSelectKeyAction('ArrowDown', 1, options.length, true), { type: 'highlight', index: 2 });
  assert.deepEqual(resolveCustomSelectKeyAction('ArrowUp', 0, options.length, true), { type: 'highlight', index: 2 });
  assert.deepEqual(resolveCustomSelectKeyAction('Home', 2, options.length, true), { type: 'highlight', index: 0 });
  assert.deepEqual(resolveCustomSelectKeyAction('End', 0, options.length, true), { type: 'highlight', index: 2 });
  assert.deepEqual(resolveCustomSelectKeyAction('Enter', 2, options.length, true), { type: 'select', index: 2 });
  assert.deepEqual(resolveCustomSelectKeyAction('Escape', 2, options.length, true), { type: 'close' });
});
