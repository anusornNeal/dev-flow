import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const content = fs.readFileSync(new URL('../../skills/brainstorming-guidance.md', import.meta.url), 'utf8');

const requiredPatterns = [
  /Id:\s*`brainstorming-guidance`/i,
  /Kind:\s*`guidance`/i,
  /Source:\s*https:\/\/github\.com\/obra\/superpowers\/tree\/main\/skills\/brainstorming/i,
  /Source snapshot:\s*2026-08-13/i,
  /Keep the process proportional/i,
  /\*\*Spike\*\*/i,
  /\*\*Bounded\*\*/i,
  /\*\*Architectural\*\*/i,
  /Inspect context before asking/i,
  /one material question at a time/i,
  /two or three viable approaches/i,
  /trade-offs/i,
  /Recommend one approach/i,
  /explicit approval/i,
  /Bounded.*in-chat design/is,
  /Architectural.*written specification/is,
];

const forbiddenRuntimeCoupling = [
  /CLAUDE_PLUGIN_ROOT/i,
  /\.claude[\\/]skills/i,
  /\bpython(?:3)?\b/i,
  /\bnode(?:\.js)?\b/i,
  /\bnpm\b/i,
  /\bnpx\b/i,
  /\bpnpm\b/i,
  /\byarn\b/i,
  /\bCLI\b/i,
  /invoke\s+(?:an?\s+)?external\s+skill/i,
  /commit_task_owned_changes/i,
  /run_project_command/i,
  /prepare_session_workspace/i,
  /apply_and_verify/i,
  /finalize_task_workspace/i,
];

test('brainstorming guidance preserves the approved process contract', () => {
  for (const pattern of requiredPatterns) {
    assert.match(content, pattern);
  }
});

test('brainstorming guidance stays guidance-only and runtime-neutral', () => {
  for (const pattern of forbiddenRuntimeCoupling) {
    assert.doesNotMatch(content, pattern);
  }
});

test('brainstorming guidance stays compact enough for on-demand retrieval', () => {
  assert.ok(content.length < 6000, `expected compact guidance, received ${content.length} characters`);
  assert.ok(content.split(/\r?\n/).length < 100, 'expected guidance to stay under 100 lines');
});
