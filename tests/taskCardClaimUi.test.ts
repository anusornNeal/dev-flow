import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/components/TaskCard.tsx', 'utf8');

test('TaskCard renders Live Work directly from the server projection', () => {
  assert.match(source, /task\.liveWork/);
  assert.match(source, />Live Work</);
  assert.match(source, /task\.liveWork\.ownerLabel/);
  assert.match(source, /task\.liveWork\.phaseLabel/);
  assert.match(source, /task\.liveWork\.activity/);
  assert.match(source, /task\.liveWork!?\.phaseIndex/);
  assert.match(source, /task\.liveWork\.phaseCount/);
  assert.match(source, /liveWorkFreshness/);
});

test('TaskCard avoids duplicate managed and legacy run status blocks', () => {
  assert.match(source, /!task\.liveWork && \(task\.activeAgent \|\| autoWorkState\)/);
  assert.doesNotMatch(source, /กำลังทำ ·/);
  assert.doesNotMatch(source, /const activeClaim =/);
});

test('TaskCard keeps blocked state and dark-mode presentation explicit', () => {
  assert.match(source, /task\.liveWork\.blocked/);
  assert.match(source, /Live work phase:/);
  assert.match(source, /dark:bg/);
  assert.match(source, /dark:border/);
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
