import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UI_PREVIEW_DESIGN_GATE_POLICY_VERSION,
  UI_PREVIEW_DESIGN_RULES,
  evaluateUiPreviewDesignGate,
} from '../../src/server/services/uiPreviewDesignGateService.js';

function context(overrides: Record<string, any> = {}) {
  return {
    taskId: 'task-1',
    projectId: 'project-a',
    repositoryRevision: 'repo-a',
    contextSchemaVersion: 1,
    gatePolicyVersion: UI_PREVIEW_DESIGN_GATE_POLICY_VERSION,
    contextHash: 'a'.repeat(64),
    sufficiency: 'sufficient',
    reasonCodes: ['VISUAL_BASIS_FOUND', 'CONTEXT_COMPLETE'],
    visual: {
      colors: ['#2457d6', '#ffffff'],
      semanticColors: ['primary', 'surface'],
      fontFamilies: ['Inter'],
      fontWeights: ['400', '600'],
      spacing: ['8px', '16px'],
      radii: ['8px'],
      dimensions: ['40px'],
      iconConventions: [],
      sharedComponents: ['ConfirmDialog'],
      referenceScreens: ['SettingsScreen'],
    },
    ux: { ruleIds: ['keyboard-focus-visible', 'destructive-action-confirmation'] },
    unknowns: [],
    sources: [
      { path: 'src/styles/theme.css', startLine: 1, endLine: 30, trustClass: 'repo-evidence-untrusted', evidenceRole: 'project-foundation' },
      { path: 'src/components/ConfirmDialog.tsx', startLine: 1, endLine: 40, trustClass: 'repo-evidence-untrusted', evidenceRole: 'project-ui-reference' },
    ],
    renderAssets: [],
    ...overrides,
  } as any;
}

function screen(overrides: Record<string, any> = {}) {
  return {
    screenId: 'main',
    name: 'Main',
    html: '<main><button>Save</button><img src="logo.png" alt="Logo"></main>',
    css: 'body { color: #2457d6; font-family: Inter, sans-serif; }',
    js: '',
    spec: { schemaVersion: 1, summary: { screen: 'Main' } },
    ...overrides,
  } as any;
}

function evaluate(overrides: Record<string, any> = {}) {
  return evaluateUiPreviewDesignGate({
    screens: [screen()],
    designContext: context(),
    gatePolicyVersion: UI_PREVIEW_DESIGN_GATE_POLICY_VERSION,
    exceptionRefs: [],
    ...overrides,
  } as any);
}

test('uses a stable versioned rule registry without beauty or AI-slop scoring', () => {
  assert.equal(UI_PREVIEW_DESIGN_GATE_POLICY_VERSION, 'ui-preview-design-gate.v1');
  assert.deepEqual(UI_PREVIEW_DESIGN_RULES.map((rule) => rule.id), [
    'project.explicit-color',
    'project.explicit-font-family',
    'accessibility.image-alt',
    'interaction.non-native-click-keyboard',
    'destructive.confirmation-unproven',
    'aesthetic.unverified-gradient',
  ]);
  const result = evaluate();
  assert.equal('score' in result, false);
  assert.equal('beautyScore' in result, false);
  assert.equal(result.blocked, false);
});

test('project color and font observations warn unless server-owned context explicitly enforces a closed set', () => {
  const source = [screen({ css: '.card { color: #ff00ff; font-family: Comic Sans MS, cursive; }' })];
  const observedOnly = evaluate({ screens: source });
  assert.equal(observedOnly.blocked, false);
  assert.ok(observedOnly.findings.filter((finding: any) => finding.ruleId.startsWith('project.')).every((finding: any) => finding.severity === 'warning'));
  assert.ok(observedOnly.findings.every((finding: any) => finding.evidence.length > 0 && finding.evidence.length <= 8));
  assert.doesNotMatch(JSON.stringify(observedOnly), /\.card \{|Comic Sans MS, cursive/);

  const enforced = evaluate({
    designContext: context({
      reasonCodes: ['VISUAL_BASIS_FOUND', 'CONTEXT_COMPLETE', 'PROJECT_COLOR_SET_ENFORCED', 'PROJECT_FONT_SET_ENFORCED'],
    }),
    screens: source,
  });
  assert.equal(enforced.blocked, true);
  assert.deepEqual(enforced.findings.filter((finding: any) => finding.severity === 'error').map((finding: any) => finding.ruleId), [
    'project.explicit-color',
    'project.explicit-font-family',
  ]);
});

test('hard-fails only provable missing image alt while interaction and aesthetic guesses stay warnings', () => {
  const result = evaluate({
    screens: [screen({
      html: '<main><img src="hero.png"><div onclick="openPanel()">Open</div><button class="delete">Delete</button></main>',
      css: '.hero { background: linear-gradient(#fff, #2457d6); }',
    })],
  });
  const byRule = new Map(result.findings.map((finding: any) => [finding.ruleId, finding]));
  assert.equal(byRule.get('accessibility.image-alt')?.severity, 'error');
  assert.equal(byRule.get('interaction.non-native-click-keyboard')?.severity, 'warning');
  assert.equal(byRule.get('destructive.confirmation-unproven')?.severity, 'warning');
  assert.equal(byRule.get('aesthetic.unverified-gradient')?.severity, 'warning');
  assert.equal(result.blocked, true);
});

test('valid task requirement authority suppresses only the explicitly authorized matching rule', () => {
  const result = evaluate({
    screens: [screen({ html: '<main><img src="logo.png"></main>' })],
    exceptionRefs: [{
      exceptionId: 'ex-alt',
      ruleIds: ['accessibility.image-alt'],
      categories: [],
      authority: {
        type: 'task-requirement',
        authorityId: 'task-1:acceptanceCriteria',
        taskId: 'task-1',
        projectId: 'project-a',
        current: true,
        authorizedRuleIds: ['accessibility.image-alt'],
        authorizedCategories: [],
      },
    }],
  });
  assert.equal(result.blocked, false);
  assert.equal(result.findings.some((finding: any) => finding.ruleId === 'accessibility.image-alt'), false);
  assert.equal(result.suppressedFindings[0]?.ruleId, 'accessibility.image-alt');
  assert.equal(result.exceptionResults[0]?.status, 'applied');
  assert.deepEqual(result.exceptionResults[0]?.suppressedRuleIds, ['accessibility.image-alt']);
});

test('rejects missing, stale, unrelated, unauthorized, and non-conflicting exception authority structurally', () => {
  const base = {
    screens: [screen({ html: '<main><img src="logo.png"></main>' })],
  };
  const result = evaluate({
    ...base,
    exceptionRefs: [
      { exceptionId: 'missing', ruleIds: ['accessibility.image-alt'], reason: 'trust me' },
      { exceptionId: 'stale', ruleIds: ['accessibility.image-alt'], authority: { type: 'task-requirement', authorityId: 'a', taskId: 'task-1', projectId: 'project-a', current: false, authorizedRuleIds: ['accessibility.image-alt'], authorizedCategories: [] } },
      { exceptionId: 'unrelated', ruleIds: ['accessibility.image-alt'], authority: { type: 'frozen-ui-design', authorityId: 'b', taskId: 'task-2', projectId: 'project-b', current: true, authorizedRuleIds: ['accessibility.image-alt'], authorizedCategories: [] } },
      { exceptionId: 'unauthorized', ruleIds: ['accessibility.image-alt'], authority: { type: 'task-requirement', authorityId: 'c', taskId: 'task-1', projectId: 'project-a', current: true, authorizedRuleIds: ['project.explicit-color'], authorizedCategories: [] } },
      { exceptionId: 'no-conflict', ruleIds: ['project.explicit-color'], authority: { type: 'task-requirement', authorityId: 'd', taskId: 'task-1', projectId: 'project-a', current: true, authorizedRuleIds: ['project.explicit-color'], authorizedCategories: [] } },
    ],
  });
  assert.deepEqual(result.exceptionResults.map((entry: any) => [entry.exceptionId, entry.status, entry.reasonCode]), [
    ['missing', 'rejected', 'EXCEPTION_AUTHORITY_MISSING'],
    ['stale', 'rejected', 'EXCEPTION_AUTHORITY_STALE'],
    ['unrelated', 'rejected', 'EXCEPTION_AUTHORITY_UNRELATED'],
    ['unauthorized', 'rejected', 'EXCEPTION_TARGET_UNAUTHORIZED'],
    ['no-conflict', 'rejected', 'EXCEPTION_NO_CONFLICTING_FINDING'],
  ]);
  assert.equal(result.blocked, true);
});

test('rejects a mismatched gate policy version instead of silently changing rule severity', () => {
  assert.throws(
    () => evaluate({ gatePolicyVersion: 'ui-preview-design-gate.v0' }),
    (error: any) => error?.code === 'UI_PREVIEW_DESIGN_GATE_POLICY_MISMATCH',
  );
});

test('is deterministic for identical source, context, policy, and exception inputs', () => {
  const input = {
    screens: [screen({ html: '<main><img src="x.png"><div onclick="x()">X</div></main>' })],
    designContext: context(),
    gatePolicyVersion: UI_PREVIEW_DESIGN_GATE_POLICY_VERSION,
    exceptionRefs: [],
  };
  const first = evaluateUiPreviewDesignGate(input as any);
  const second = evaluateUiPreviewDesignGate(structuredClone(input) as any);
  assert.deepEqual(second, first);
});
