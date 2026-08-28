import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConfirmModal from '../../src/components/ConfirmModal.js';

const noop = () => {};

test('confirm modal exposes accessible dialog semantics and safe destructive hierarchy', () => {
  const html = renderToStaticMarkup(React.createElement(ConfirmModal, {
    title: 'Delete Task',
    message: 'Delete this task and its associated local metadata? This cannot be undone.',
    onConfirm: noop,
    onCancel: noop,
    confirmText: 'Delete',
  }));

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="confirm-modal-title"/);
  assert.match(html, /df-dialog/);
  assert.match(html, /df-button--danger/);
  assert.match(html, /df-button--secondary/);
  assert.match(html, /aria-label="Close confirmation dialog"/);
});

test('confirm modal keeps the safe cancel action as the initial focus target', () => {
  const html = renderToStaticMarkup(React.createElement(ConfirmModal, {
    title: 'Delete Project',
    message: 'This action cannot be undone.',
    onConfirm: noop,
    onCancel: noop,
  }));

  assert.match(html, /autofocus=""/i);
  assert.match(html, /Cancel/);
});

test('confirm modal represents busy and disabled confirmation states without changing callbacks', () => {
  const html = renderToStaticMarkup(React.createElement(ConfirmModal, {
    title: 'Delete Task',
    message: 'This action cannot be undone.',
    onConfirm: noop,
    onCancel: noop,
    confirming: true,
    confirmText: 'Delete',
  }));

  assert.match(html, /Deleting…/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
});
