import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/components/TaskCard.tsx', 'utf8');

test('TaskCard renders compact active claim ownership and hides the ownership row when unclaimed', () => {
  assert.match(source, /task\.claim/);
  assert.match(source, /ownerLabel/);
  assert.match(source, /expiresAt/);
  assert.match(source, /activeClaim/);
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
