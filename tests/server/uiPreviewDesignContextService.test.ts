import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUnderTest = await import('../../src/server/services/uiPreviewDesignContextService.js').catch(() => null as any);

function requireModule() {
  assert.ok(moduleUnderTest, 'uiPreviewDesignContextService module should exist');
  return moduleUnderTest!;
}

function foundationBundle(repoRevision = 'repo-a') {
  return {
    repoRevision,
    snippets: [
      {
        path: 'src/styles/theme.css',
        startLine: 1,
        endLine: 30,
        content: `:root { --color-primary: #2457d6; --space-sm: 8px; --radius-md: 10px; }\nbody { font-family: Inter, sans-serif; font-weight: 400; }\n.button { height: 40px; cursor: pointer; }\n.button:hover { opacity: .9; }\n/* copy convention: sentence case */`,
      },
      {
        path: 'src/components/ConfirmDialog.tsx',
        startLine: 1,
        endLine: 40,
        content: `export function ConfirmDialog() { return <button aria-label="Confirm delete" className="focus-visible:ring-2">Delete</button>; }`,
      },
      {
        path: 'src/screens/BrandRegistry.tsx',
        startLine: 1,
        endLine: 40,
        content: `export function BrandRegistry() { return <table><tbody><tr><td>Brand</td></tr></tbody></table>; }`,
      },
    ],
  };
}

test('task scope derives project and rejects caller disagreement', () => {
  const { createUiPreviewDesignContextService } = requireModule();
  const service = createUiPreviewDesignContextService({
    state: { countersCache: {} },
    resolveTask: () => ({ id: 'task-1', displayId: 'DVF-1', projectId: 'project-a' }),
    resolveProject: (id: string) => ({ id, name: 'A' }),
    getContextBundle: () => foundationBundle(),
  });

  assert.throws(
    () => service.get({ taskId: 'DVF-1', projectId: 'project-b' }),
    (error: any) => error?.code === 'UI_PREVIEW_DESIGN_CONTEXT_PROJECT_MISMATCH',
  );
});

test('normalizes bounded project evidence without returning raw bodies or local paths', () => {
  const { createUiPreviewDesignContextService } = requireModule();
  let observedContextRequest: any;

  const service = createUiPreviewDesignContextService({
    state: { countersCache: {} },
    resolveTask: () => ({ id: 'task-1', projectId: 'project-a' }),
    resolveProject: (id: string) => ({ id, name: 'A', localPath: 'C:\\secret\\repo' }),
    getContextBundle: (args: any) => { observedContextRequest = args; return foundationBundle(); },
  });

  const result = service.get({ taskId: 'task-1', relevanceHint: 'brand registry dialog' });
  assert.equal(result.projectId, 'project-a');
  assert.equal(result.contextSchemaVersion, 1);
  assert.equal(typeof result.gatePolicyVersion, 'string');
  assert.match(result.contextHash, /^[0-9a-f]{64}$/);
  assert.equal(result.repositoryRevision, 'repo-a');
  assert.match(observedContextRequest.q, /brand registry dialog/);
  assert.equal(result.sufficiency, 'partial');
  assert.ok(result.visual.colors.includes('#2457d6'));
  assert.ok(result.visual.semanticColors.includes('primary'));
  assert.ok(result.visual.fontFamilies.includes('Inter'));
  assert.ok(result.visual.spacing.includes('8px'));
  assert.ok(result.visual.radii.includes('10px'));
  assert.ok(result.visual.dimensions.includes('40px'));
  assert.ok(result.visual.sharedComponents.includes('ConfirmDialog'));
  assert.ok(result.visual.referenceScreens.includes('BrandRegistry'));
  assert.ok(result.ux.ruleIds.includes('keyboard-focus-visible'));
  assert.ok(result.ux.ruleIds.includes('hover-interaction'));
  assert.ok(result.ux.ruleIds.includes('pointer-cursor-affordance'));
  assert.ok(result.ux.ruleIds.includes('copy-sentence-case'));
  assert.ok(result.ux.ruleIds.includes('destructive-action-confirmation'));
  assert.ok(result.ux.ruleIds.includes('tabular-data-presentation'));
  assert.ok(result.sources.length <= 12);
  assert.ok(result.sources.every((source: any) => source.trustClass === 'repo-evidence-untrusted'));
  assert.ok(result.sources.every((source: any) => !/^[A-Za-z]:[\\/]/.test(source.path)));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /C:\\\\secret\\\\repo/);
  assert.doesNotMatch(serialized, /Confirm delete/);
  assert.doesNotMatch(serialized, /<button/);
  assert.doesNotMatch(serialized, /relevanceHint/);
});

test('reports sufficient only when the available evidence covers every normalized design category', () => {
  const { createUiPreviewDesignContextService } = requireModule();
  const service = createUiPreviewDesignContextService({
    state: { countersCache: {} },
    resolveTask: () => null,
    resolveProject: (id: string) => ({ id, name: 'A' }),
    getContextBundle: () => ({
      repoRevision: 'repo-complete',
      snippets: [
        { path: 'src/styles/theme.css', startLine: 1, endLine: 8, content: `:root { --color-primary: #123456; --space-sm: 8px; --radius-md: 6px; } body { font-family: Inter; font-weight: 500; } .button { height: 40px; cursor: pointer; } .button:hover { opacity: .9; } @media (max-width: 800px) { .button { width: 100%; } } /* copy convention: sentence case */` },
        { path: 'src/components/CompleteDialog.tsx', startLine: 1, endLine: 20, content: `export function CompleteDialog() { const primaryButton = true; const loading = true; const required = true; navigate('/home'); return <div aria-label="Panel"><Select/><DeleteIcon/><Accordion/></div>; }` },
        { path: 'src/screens/HomeScreen.tsx', startLine: 1, endLine: 4, content: `export function HomeScreen() { return <CompleteDialog />; }` },
      ],
    }),
  });

  const result = service.get({ projectId: 'project-a' });
  assert.equal(result.sufficiency, 'sufficient');
  assert.deepEqual(result.unknowns, []);
  assert.ok(result.reasonCodes.includes('CONTEXT_COMPLETE'));
});

test('caps normalized design categories independently of bounded snippet input size', () => {
  const { createUiPreviewDesignContextService } = requireModule();
  const declarations = Array.from({ length: 80 }, (_, index) => `--color-token-${index}: #${index.toString(16).padStart(6, '0')};`).join('\n');
  const service = createUiPreviewDesignContextService({
    state: { countersCache: {} },
    resolveTask: () => null,
    resolveProject: (id: string) => ({ id, name: 'A' }),
    getContextBundle: () => ({ repoRevision: 'repo-many', snippets: [{ path: 'src/styles/theme.css', startLine: 1, endLine: 80, content: declarations }] }),
  });

  const result = service.get({ projectId: 'project-a' });
  assert.ok(result.visual.colors.length <= 32);
  assert.ok(result.visual.semanticColors.length <= 32);
});

test('context hash is stable across unrelated repo revision changes and changes with design evidence', () => {
  const { createUiPreviewDesignContextService } = requireModule();
  let bundle = foundationBundle('repo-a');
  const service = createUiPreviewDesignContextService({
    state: { countersCache: {} },
    resolveTask: () => null,
    resolveProject: (id: string) => ({ id, name: 'A' }),
    getContextBundle: () => bundle,
  });

  const first = service.get({ projectId: 'project-a' });
  bundle = foundationBundle('repo-b');
  const unrelatedRevision = service.get({ projectId: 'project-a' });
  assert.equal(unrelatedRevision.contextHash, first.contextHash);

  bundle = foundationBundle('repo-c');
  bundle.snippets[0].content = bundle.snippets[0].content.replace('#2457d6', '#1f9d55');
  const changedEvidence = service.get({ projectId: 'project-a' });
  assert.notEqual(changedEvidence.contextHash, first.contextHash);
});

test('reports deterministic insufficient context when no visual foundation or UI reference exists', () => {
  const { createUiPreviewDesignContextService } = requireModule();
  const service = createUiPreviewDesignContextService({
    state: { countersCache: {} },
    resolveTask: () => null,
    resolveProject: (id: string) => ({ id, name: 'A' }),
    getContextBundle: () => ({ repoRevision: 'repo-empty', snippets: [{ path: 'README.md', startLine: 1, endLine: 2, content: 'Backend service notes only.' }] }),
  });

  const result = service.get({ projectId: 'project-a' });
  assert.equal(result.sufficiency, 'insufficient');
  assert.ok(result.reasonCodes.includes('NO_VISUAL_BASIS'));
  assert.ok(result.unknowns.includes('palette'));
  assert.ok(result.unknowns.includes('typography'));
});
