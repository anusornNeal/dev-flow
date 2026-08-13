import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const content = fs.readFileSync(new URL('../../skills/ui-ux-guidance.md', import.meta.url), 'utf8');

test('ui ux guidance declares stable identity, applicability, and skip boundary', () => {
  assert.match(content, /Skill id:\s*`ui-ux-guidance`/i);
  assert.match(content, /Kind:\s*`guidance`/i);
  assert.match(content, /visual structure/i);
  assert.match(content, /layout/i);
  assert.match(content, /interaction/i);
  assert.match(content, /navigation/i);
  assert.match(content, /accessibility/i);
  assert.match(content, /animation/i);
  assert.match(content, /data presentation/i);
  assert.match(content, /Skip it for pure backend, infrastructure/i);
});

test('ui ux guidance covers product inspection and coherent design decisions', () => {
  assert.match(content, /inspect the existing screens, components, navigation, and interaction patterns/i);
  assert.match(content, /detect the actual platform, framework, styling system/i);
  assert.match(content, /preserve established product patterns unless the requirement explicitly changes them/i);
  assert.match(content, /coherent design direction/i);
  assert.match(content, /Hierarchy/i);
  assert.match(content, /Spacing and density/i);
  assert.match(content, /Typography and color/i);
  assert.match(content, /States and feedback/i);
  assert.match(content, /Responsive behavior/i);
  assert.match(content, /Accessibility/i);
  assert.match(content, /Interaction quality/i);
  assert.match(content, /trade-offs/i);
});

test('ui ux guidance uses DevFlow preview and stays decoupled from upstream runtime', () => {
  assert.match(content, /DevFlow UI Preview/i);
  assert.match(content, /Do not substitute generated images for a product UI preview/i);
  assert.match(content, /Image generation is not required/i);
  assert.match(content, /does not require or invoke Python, Node\.js, a CLI, CSV design databases, templates, external packages/i);
  assert.match(content, /upstream agent-specific filesystem paths/i);

  assert.doesNotMatch(content, /\.claude\/skills/i);
  assert.doesNotMatch(content, /CLAUDE_PLUGIN_ROOT/i);
  assert.doesNotMatch(content, /python\s+[^\n]*ui[_-]?ux/i);
  assert.doesNotMatch(content, /npm\s+(?:install|run)/i);
  assert.doesNotMatch(content, /npx\s+/i);
});
