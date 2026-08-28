import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/components/TaskCard.tsx', 'utf8');

test('TaskCard renders Live Work directly from the server projection', () => {
  assert.match(source, /const liveWork = task\.liveWork/);
  assert.match(source, /\{liveWork && \(/);
  assert.match(source, /Live work/);
  assert.match(source, /liveWork\.ownerLabel/);
  assert.match(source, /liveWork\.phaseLabel/);
  assert.match(source, /liveWork\.activity/);
  assert.match(source, /liveWork\.phaseIndex/);
  assert.match(source, /liveWork\.phaseCount/);
  assert.match(source, /liveWorkFreshness/);
});

test('TaskCard avoids duplicate managed and legacy run status blocks', () => {
  assert.match(source, /!liveWork && \(task\.activeAgent \|\| autoWorkState\)/);
  assert.doesNotMatch(source, /กำลังทำ ·/);
  assert.doesNotMatch(source, /const activeClaim =/);
});

test('TaskCard keeps blocked state and theme presentation explicit', () => {
  assert.match(source, /liveWork\.blocked/);
  assert.match(source, /Live work phase:/);
  assert.match(source, /var\(--df-color-danger-surface\)/);
  assert.match(source, /var\(--df-color-warning-surface\)/);
  assert.match(source, /var\(--df-color-border\)/);
});

test('TaskCard no longer exposes inline agent, model, or effort assignment controls', () => {
  assert.doesNotMatch(source, /isEditingAgent/);
  assert.doesNotMatch(source, /setAgentMenuOpen/);
  assert.doesNotMatch(source, /setModelMenuOpen/);
  assert.doesNotMatch(source, /AGENTS_CONFIG/);
  assert.doesNotMatch(source, /defaultModelForAgent/);
  assert.doesNotMatch(source, /Unassigned/);
  assert.doesNotMatch(source, /Row 2: Agent, Model & Effort/);
});
