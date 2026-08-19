import { createHash } from 'node:crypto';
import type { AppState } from '../types.js';
import { UiPreviewError, type UiPreviewDesignContext, type UiPreviewDesignContextSource, type UiPreviewDesignContextSufficiency } from '../domain/uiPreview.js';
import { getProject } from '../repositories/projectRepository.js';
import { getTaskByIdentifier } from '../repositories/taskRepository.js';
import { getRepoContextBundle } from './projectStartContextService.js';

export const UI_PREVIEW_DESIGN_CONTEXT_SCHEMA_VERSION = 1 as const;
export const UI_PREVIEW_DESIGN_GATE_POLICY_VERSION = 'ui-preview-design-gate.v1';

const MAX_SOURCES = 12;
const DESIGN_QUERY = [
  'design system theme tokens colors palette typography font spacing radius dimensions density icons components',
  'screen page dialog modal selector dropdown table loading empty error focus hover keyboard validation destructive responsive accessibility copy',
].join(' ');

const UNKNOWN_KEYS = [
  'palette', 'typography', 'spacing', 'radii', 'dimensions-density', 'icon-conventions', 'shared-components', 'reference-screens',
  'hierarchy-navigation', 'action-hierarchy', 'dialogs', 'selectors-tables', 'feedback-states', 'hover-focus-cursor-keyboard',
  'validation-destructive', 'progressive-disclosure', 'responsive-window', 'accessibility', 'copy-conventions',
] as const;

const MAX_NORMALIZED_VALUES = 32;

function uniq(values: Iterable<string>) {
  return [...new Set([...values].map((value) => String(value || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)).slice(0, MAX_NORMALIZED_VALUES);
}

function repoRelativePath(value: unknown) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) return null;
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function componentNames(path: string, content: string) {
  const names = new Set<string>();
  const base = path.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
  if (/^[A-Z][A-Za-z0-9]+$/.test(base)) names.add(base);
  for (const match of content.matchAll(/\b(?:export\s+)?(?:function|class|const)\s+([A-Z][A-Za-z0-9]+)/g)) names.add(match[1]);
  return [...names];
}

function extractVisual(snippets: Array<{ path: string; content: string }>) {
  const colors = new Set<string>();
  const semanticColors = new Set<string>();
  const fontFamilies = new Set<string>();
  const fontWeights = new Set<string>();
  const spacing = new Set<string>();
  const radii = new Set<string>();
  const dimensions = new Set<string>();
  const iconConventions = new Set<string>();
  const sharedComponents = new Set<string>();
  const referenceScreens = new Set<string>();

  for (const snippet of snippets) {
    const content = snippet.content;
    for (const match of content.matchAll(/--(?:color|colour)-([a-z0-9-]+)\s*:/gi)) semanticColors.add(match[1].toLowerCase());
    for (const match of content.matchAll(/\b(primary|secondary|accent|background|foreground|surface|text|border|danger|success|warning|error)\s*:\s*['\"](?:#|rgb|hsl)/gi)) semanticColors.add(match[1].toLowerCase());
    for (const match of content.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) colors.add(match[0].toLowerCase());
    for (const match of content.matchAll(/\b(?:rgb|rgba|hsl|hsla)\([^\n;)]+\)/gi)) colors.add(match[0].replace(/\s+/g, ' '));
    for (const match of content.matchAll(/font-family\s*:\s*([^;\n}]+)/gi)) {
      const family = match[1].split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (family) fontFamilies.add(family);
    }
    for (const match of content.matchAll(/fontFamily\s*[:=]\s*['"]([^'"]+)['"]/g)) fontFamilies.add(match[1].split(',')[0].trim());
    for (const match of content.matchAll(/font-weight\s*:\s*([1-9]00|normal|bold)\b/gi)) fontWeights.add(match[1].toLowerCase());
    for (const match of content.matchAll(/\b(?:gap|padding|margin)(?:-[a-z]+)?\s*:\s*(-?\d+(?:\.\d+)?(?:px|rem|em))\b/gi)) spacing.add(match[1].toLowerCase());
    for (const match of content.matchAll(/--(?:space|spacing)-[\w-]+\s*:\s*(-?\d+(?:\.\d+)?(?:px|rem|em))\b/gi)) spacing.add(match[1].toLowerCase());
    for (const match of content.matchAll(/(?:border-radius|--radius-[\w-]+)\s*:\s*(\d+(?:\.\d+)?(?:px|rem|em|%))\b/gi)) radii.add(match[1].toLowerCase());
    for (const match of content.matchAll(/\b(?:width|height|min-width|min-height|max-width|max-height)\s*:\s*(\d+(?:\.\d+)?(?:px|rem|em|vw|vh|%))\b/gi)) dimensions.add(match[1].toLowerCase());
    for (const match of content.matchAll(/\b([A-Z][A-Za-z0-9]*(?:Icon|Icons))\b/g)) iconConventions.add(match[1]);
    if (/(?:^|\/)components?\//i.test(snippet.path)) for (const name of componentNames(snippet.path, content)) sharedComponents.add(name);
    if (/(?:^|\/)(?:screens?|pages?|views?)\//i.test(snippet.path)) for (const name of componentNames(snippet.path, content)) referenceScreens.add(name);
  }

  return {
    colors: uniq(colors),
    semanticColors: uniq(semanticColors),
    fontFamilies: uniq(fontFamilies),
    fontWeights: uniq(fontWeights),
    spacing: uniq(spacing),
    radii: uniq(radii),
    dimensions: uniq(dimensions),
    iconConventions: uniq(iconConventions),
    sharedComponents: uniq(sharedComponents),
    referenceScreens: uniq(referenceScreens),
  };
}

function extractUx(snippets: Array<{ path: string; content: string }>) {
  const rules = new Set<string>();
  for (const snippet of snippets) {
    const haystack = `${snippet.path}\n${snippet.content}`;
    if (/:hover\b|hover:|onMouseEnter|onPointerEnter/i.test(haystack)) rules.add('hover-interaction');
    if (/cursor\s*:\s*pointer|cursor-pointer|Cursor\.Hand/i.test(haystack)) rules.add('pointer-cursor-affordance');
    if (/sentence[ -]?case|copy convention[^\n]*sentence/i.test(haystack)) rules.add('copy-sentence-case');
    if (/title[ -]?case|copy convention[^\n]*title/i.test(haystack)) rules.add('copy-title-case');
    if (/focus-visible|onKeyDown|tabIndex|keyboard/i.test(haystack)) rules.add('keyboard-focus-visible');
    if (/aria-(?:label|labelledby|describedby)|role=['"](?:dialog|alert|button)/i.test(haystack)) rules.add('accessible-control-labeling');
    if (/(?:confirm|confirmation).*(?:delete|remove|destructive)|(?:delete|remove|destructive).*(?:confirm|confirmation)/is.test(haystack) || /Confirm(?:Delete|Dialog)/.test(haystack)) rules.add('destructive-action-confirmation');
    if (/<table\b|DataTable|Table(?:View|Row|Cell)?\b/i.test(haystack)) rules.add('tabular-data-presentation');
    if (/Dialog|Modal|role=['"]dialog/i.test(haystack)) rules.add('modal-dialog-pattern');
    if (/Select|Dropdown|ComboBox|<select\b/i.test(haystack)) rules.add('selector-control-pattern');
    if (/loading|spinner|skeleton|empty state|error state|success state/i.test(haystack)) rules.add('feedback-state-pattern');
    if (/@media|responsive|windowWidth|useWindow|breakpoint/i.test(haystack)) rules.add('responsive-window-behavior');
    if (/collapse|expand|accordion|progressive disclosure/i.test(haystack)) rules.add('progressive-disclosure');
    if (/breadcrumb|navigation|navigate\(|router|sidebar|tabs?\b/i.test(haystack)) rules.add('navigation-hierarchy');
    if (/primaryButton|secondaryButton|destructiveButton|variant=['"](?:primary|secondary|danger)/i.test(haystack)) rules.add('action-hierarchy');
    if (/validation|required|invalid|errorMessage/i.test(haystack)) rules.add('validation-feedback');
  }
  return { ruleIds: uniq(rules) };
}

function evidenceRole(path: string) {
  if (/(?:^|\/)(?:design-system|theme|themes|styles|tokens|tailwind|ui)\b|(?:design|theme|tokens?)\.(?:css|scss|ts|tsx|js|json)$/i.test(path)) return 'project-foundation' as const;
  if (/(?:^|\/)(?:screens?|pages?|views?|components?)\//i.test(path)) return 'project-ui-reference' as const;
  return 'project-repo-evidence' as const;
}

function buildSources(snippets: any[]): UiPreviewDesignContextSource[] {
  const sources: UiPreviewDesignContextSource[] = [];
  for (const snippet of snippets) {
    if (sources.length >= MAX_SOURCES) break;
    const path = repoRelativePath(snippet?.path);
    if (!path) continue;
    sources.push({
      path,
      startLine: Number.isInteger(Number(snippet?.startLine)) ? Math.max(1, Number(snippet.startLine)) : undefined,
      endLine: Number.isInteger(Number(snippet?.endLine)) ? Math.max(1, Number(snippet.endLine)) : undefined,
      trustClass: 'repo-evidence-untrusted',
      evidenceRole: evidenceRole(path),
    });
  }
  return sources;
}

function normalizeRenderAssetFont(asset: any) {
  const font = asset?.font;
  if (!font || typeof font !== 'object' || Array.isArray(font)) return undefined;
  const family = String(font.family || '').trim();
  const weight = Number(font.weight);
  const style = String(font.style || '').trim();
  const mimeType = String(font.mimeType || '').trim();
  const byteLength = Number(font.byteLength);
  if (!family || family.length > 120 || /[\\/\r\n<>]/.test(family) || /^[a-z][a-z0-9+.-]*:/i.test(family)) return undefined;
  if (!Number.isInteger(weight) || weight < 1 || weight > 1000) return undefined;
  if (style !== 'normal' && style !== 'italic') return undefined;
  if (!mimeType || mimeType.length > 80 || /[\\/\r\n<>]/.test(mimeType.replace(/^font\//i, ''))) return undefined;
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 1_000_000_000) return undefined;
  return { family, weight, style, mimeType, byteLength };
}

function normalizeRenderAssets(bundle: any) {
  if (!Array.isArray(bundle?.renderAssets)) return [];
  return bundle.renderAssets.slice(0, 12).map((asset: any) => {
    const kind = String(asset?.kind || asset?.type || 'asset').trim();
    const font = kind === 'font' ? normalizeRenderAssetFont(asset) : undefined;
    return {
      assetId: String(asset?.assetId || asset?.id || '').trim(),
      kind,
      contentIdentity: String(asset?.contentIdentity || asset?.contentHash || asset?.sha256 || '').trim(),
      ...(font ? { font } : {}),
    };
  }).filter((asset: any) => asset.assetId && asset.contentIdentity);
}

function unknownsFor(visual: ReturnType<typeof extractVisual>, ux: ReturnType<typeof extractUx>) {
  const unknowns = new Set<string>();
  if (!visual.colors.length && !visual.semanticColors.length) unknowns.add('palette');
  if (!visual.fontFamilies.length && !visual.fontWeights.length) unknowns.add('typography');
  if (!visual.spacing.length) unknowns.add('spacing');
  if (!visual.radii.length) unknowns.add('radii');
  if (!visual.dimensions.length) unknowns.add('dimensions-density');
  if (!visual.iconConventions.length) unknowns.add('icon-conventions');
  if (!visual.sharedComponents.length) unknowns.add('shared-components');
  if (!visual.referenceScreens.length) unknowns.add('reference-screens');
  const rules = new Set(ux.ruleIds);
  if (!rules.has('navigation-hierarchy')) unknowns.add('hierarchy-navigation');
  if (!rules.has('action-hierarchy')) unknowns.add('action-hierarchy');
  if (!rules.has('modal-dialog-pattern')) unknowns.add('dialogs');
  if (!rules.has('selector-control-pattern') && !rules.has('tabular-data-presentation')) unknowns.add('selectors-tables');
  if (!rules.has('feedback-state-pattern')) unknowns.add('feedback-states');
  if (!rules.has('keyboard-focus-visible') && !rules.has('hover-interaction') && !rules.has('pointer-cursor-affordance')) unknowns.add('hover-focus-cursor-keyboard');
  if (!rules.has('validation-feedback') && !rules.has('destructive-action-confirmation')) unknowns.add('validation-destructive');
  if (!rules.has('progressive-disclosure')) unknowns.add('progressive-disclosure');
  if (!rules.has('responsive-window-behavior')) unknowns.add('responsive-window');
  if (!rules.has('accessible-control-labeling')) unknowns.add('accessibility');
  if (![...rules].some((rule) => rule.startsWith('copy-'))) unknowns.add('copy-conventions');
  return UNKNOWN_KEYS.filter((key) => unknowns.has(key));
}

function sufficiencyFor(sources: UiPreviewDesignContextSource[], visual: ReturnType<typeof extractVisual>, unknowns: string[]) {
  const hasFoundation = sources.some((source) => source.evidenceRole === 'project-foundation')
    && Boolean(visual.colors.length || visual.semanticColors.length || visual.fontFamilies.length || visual.spacing.length || visual.radii.length || visual.dimensions.length);
  const hasUiReference = sources.some((source) => source.evidenceRole === 'project-ui-reference');
  if (!hasFoundation && !hasUiReference) return { sufficiency: 'insufficient' as UiPreviewDesignContextSufficiency, reasonCodes: ['NO_VISUAL_BASIS'] };
  if (unknowns.length > 0) return { sufficiency: 'partial' as UiPreviewDesignContextSufficiency, reasonCodes: ['VISUAL_BASIS_FOUND', 'CONTEXT_CATEGORIES_UNKNOWN'] };
  return { sufficiency: 'sufficient' as UiPreviewDesignContextSufficiency, reasonCodes: ['VISUAL_BASIS_FOUND', 'CONTEXT_COMPLETE'] };
}

export interface UiPreviewDesignContextServiceDeps {
  state: AppState;
  resolveTask?: (identifier: string) => any;
  resolveProject?: (projectId: string) => any;
  getContextBundle?: (args: Record<string, any>) => any;
}

export function createUiPreviewDesignContextService(deps: UiPreviewDesignContextServiceDeps) {
  const resolveTask = deps.resolveTask ?? ((identifier: string) => getTaskByIdentifier(identifier, 'minimal'));
  const resolveProject = deps.resolveProject ?? ((projectId: string) => getProject(projectId));
  const readBundle = deps.getContextBundle ?? ((args: Record<string, any>) => getRepoContextBundle(deps.state, args));

  return {
    get(input: { taskId?: string; projectId?: string; relevanceHint?: string }): UiPreviewDesignContext {
      const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : '';
      const requestedProjectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
      const task = taskId ? resolveTask(taskId) : null;
      if (taskId && !task) throw new UiPreviewError('UI_PREVIEW_DESIGN_CONTEXT_TASK_NOT_FOUND', `Task '${taskId}' was not found.`);
      const derivedProjectId = task ? String(task.projectId || '').trim() : '';
      if (task && requestedProjectId && derivedProjectId !== requestedProjectId) {
        throw new UiPreviewError('UI_PREVIEW_DESIGN_CONTEXT_PROJECT_MISMATCH', 'Task project scope does not match the requested project scope.');
      }
      const projectId = derivedProjectId || requestedProjectId;
      if (!projectId) throw new UiPreviewError('UI_PREVIEW_DESIGN_CONTEXT_SCOPE_REQUIRED', 'taskId or projectId is required.');
      const project = resolveProject(projectId);
      if (!project) throw new UiPreviewError('UI_PREVIEW_DESIGN_CONTEXT_PROJECT_NOT_FOUND', `Project '${projectId}' was not found.`);

      const relevanceHint = typeof input?.relevanceHint === 'string' ? input.relevanceHint.trim().slice(0, 300) : '';
      const bundle = readBundle({
        projectId,
        q: `${DESIGN_QUERY}${relevanceHint ? ` ${relevanceHint}` : ''}`,
        contextIntent: 'authoring',
        limit: 20,
        snippetLimit: 12,
        snippetLines: 160,
        maxContextBytes: 60_000,
      }) || {};
      const snippets = (Array.isArray(bundle.snippets) ? bundle.snippets : [])
        .slice(0, MAX_SOURCES)
        .map((snippet: any) => ({ path: repoRelativePath(snippet?.path) || '', content: String(snippet?.content || '') }))
        .filter((snippet: any) => snippet.path);
      const visual = extractVisual(snippets);
      const ux = extractUx(snippets);
      const sources = buildSources(Array.isArray(bundle.snippets) ? bundle.snippets : []);
      const renderAssets = normalizeRenderAssets(bundle);
      const unknowns = unknownsFor(visual, ux);
      const { sufficiency, reasonCodes } = sufficiencyFor(sources, visual, unknowns);
      const contextHash = createHash('sha256').update(canonicalJson({
        contextSchemaVersion: UI_PREVIEW_DESIGN_CONTEXT_SCHEMA_VERSION,
        gatePolicyVersion: UI_PREVIEW_DESIGN_GATE_POLICY_VERSION,
        visual,
        ux,
        unknowns,
        renderAssets,
      })).digest('hex');

      return {
        taskId: task ? String(task.id || taskId) : null,
        projectId,
        repositoryRevision: String(bundle.repoRevision || ''),
        contextSchemaVersion: UI_PREVIEW_DESIGN_CONTEXT_SCHEMA_VERSION,
        gatePolicyVersion: UI_PREVIEW_DESIGN_GATE_POLICY_VERSION,
        contextHash,
        sufficiency,
        reasonCodes,
        visual,
        ux,
        unknowns,
        sources,
        renderAssets,
      };
    },
  };
}

export type UiPreviewDesignContextService = ReturnType<typeof createUiPreviewDesignContextService>;
