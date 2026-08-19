import type { AppState } from '../types';
import { createApiError } from './api';
import { readFileSnippetsBatch, searchLocalFilesAsync } from './localFileService';

const MAX_STEPS = 12;
const MAX_SEARCH_STEPS = 6;
const MAX_CONCURRENCY = 4;
const MAX_REFS = 6;
const MAX_SEARCH_LIMIT = 100;
const MAX_CANDIDATES = 100;
const MAX_SNIPPETS = 25;
const MAX_FILTER_PATTERNS = 8;
const MAX_PATTERN_LENGTH = 256;
const MAX_QUERY_LENGTH = 500;
const MAX_SNIPPET_BYTES = 20_000;
const MAX_READ_BYTES = 100_000;
const DEFAULT_RETURN_BYTES = 60_000;
const MAX_RETURN_BYTES = 100_000;
const MAX_STEP_ERRORS = 8;
const MAX_SELECTED_FIELDS = 10;

const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const SUPPORTED_OPS = new Set(['search', 'filter_path', 'dedupe', 'limit', 'read_snippets', 'select']);
const EXECUTABLE_FIELD_NAMES = new Set([
  'code', 'script', 'javascript', 'python', 'command', 'shell', 'exec', 'eval', 'request', 'network', 'url',
]);
const SELECTABLE_FIELDS = new Set([
  'path', 'line', 'preview', 'startLine', 'endLine', 'content', 'returnedBytes', 'truncated',
]);

type Logger = { stdout: (data: string) => void; stderr: (data: string) => void };
type SetCancelFn = (fn: () => void) => void;
type PlanOp = 'search' | 'filter_path' | 'dedupe' | 'limit' | 'read_snippets' | 'select';
type ValueKind = 'candidates' | 'snippets' | 'selection';
type Candidate = { path: string; line?: number; preview?: string };
type Evidence = Candidate & {
  startLine?: number;
  endLine?: number;
  content?: string;
  returnedBytes?: number;
  truncated?: boolean;
};
type NormalizedStep = Record<string, any> & { id: string; op: PlanOp; refs: string[]; index: number };
type StepOutput = { kind: ValueKind; items: Evidence[] };

type RepoQueryPlanDependencies = {
  search: typeof searchLocalFilesAsync;
  readSnippets: typeof readFileSnippetsBatch;
  now: () => number;
};

const defaultDependencies: RepoQueryPlanDependencies = {
  search: searchLocalFilesAsync,
  readSnippets: readFileSnippetsBatch,
  now: () => performance.now(),
};

function apiError(code: string, message: string, details?: Record<string, unknown>) {
  return createApiError(400, code, message, details ? { details } : undefined);
}

function integerInRange(value: unknown, fallback: number, min: number, max: number, code: string, field: string) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw apiError(code, `${field} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function normalizeRelativePath(value: unknown, field: string) {
  const raw = String(value ?? '.').trim();
  if (!raw || raw === '.') return '.';
  if (raw.length > MAX_PATTERN_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw apiError('REPO_QUERY_PLAN_PATH_INVALID', `${field} contains an invalid repository-relative path.`);
  }
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
    throw apiError('REPO_QUERY_PLAN_PATH_INVALID', `${field} must stay inside the selected repository workspace.`);
  }
  return normalized || '.';
}

function normalizePattern(value: unknown, field: string) {
  const pattern = String(value ?? '').trim().replace(/\\/g, '/');
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || /[\u0000-\u001f\u007f]/.test(pattern)) {
    throw apiError('REPO_QUERY_PLAN_PATH_INVALID', `${field} contains an invalid path pattern.`);
  }
  if (pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern) || pattern.split('/').includes('..')) {
    throw apiError('REPO_QUERY_PLAN_PATH_INVALID', `${field} must be repository-relative.`);
  }
  return pattern;
}

function normalizePatternList(value: unknown, field: string) {
  if (value === undefined) return [] as string[];
  if (!Array.isArray(value) || value.length > MAX_FILTER_PATTERNS) {
    throw apiError('REPO_QUERY_PLAN_FILTER_INVALID', `${field} must be an array with at most ${MAX_FILTER_PATTERNS} patterns.`);
  }
  return value.map((entry, index) => normalizePattern(entry, `${field}[${index}]`));
}

function normalizeRefs(value: unknown, stepId: string) {
  const refs = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  if (refs.length === 0 || refs.length > MAX_REFS) {
    throw apiError('REPO_QUERY_PLAN_REF_INVALID', `Step '${stepId}' must reference 1-${MAX_REFS} prior step ids.`);
  }
  return refs.map((entry) => {
    const ref = String(entry || '').trim();
    if (!STEP_ID.test(ref)) throw apiError('REPO_QUERY_PLAN_REF_INVALID', `Step '${stepId}' contains an invalid reference.`);
    return ref;
  });
}

function assertAllowedKeys(step: Record<string, any>, allowed: string[]) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(step)) {
    if (allowedSet.has(key)) continue;
    if (EXECUTABLE_FIELD_NAMES.has(key.toLowerCase())) {
      throw apiError('REPO_QUERY_PLAN_EXECUTION_UNSUPPORTED', `Executable field '${key}' is not supported in Repo Query Plan V1.`);
    }
    throw apiError('REPO_QUERY_PLAN_STEP_FIELD_UNSUPPORTED', `Field '${key}' is not supported for operation '${String(step.op || '')}'.`);
  }
}

function normalizeStep(raw: unknown, index: number): NormalizedStep {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw apiError('REPO_QUERY_PLAN_STEP_INVALID', `steps[${index}] must be an object.`);
  }
  const step = raw as Record<string, any>;
  const id = String(step.id || '').trim();
  if (!STEP_ID.test(id)) throw apiError('REPO_QUERY_PLAN_STEP_ID_INVALID', `steps[${index}].id is invalid.`);
  const op = String(step.op || '').trim() as PlanOp;
  if (!SUPPORTED_OPS.has(op)) {
    throw apiError('REPO_QUERY_PLAN_OPERATION_UNSUPPORTED', `Operation '${op || '(missing)'}' is not supported in Repo Query Plan V1.`);
  }

  if (op === 'search') {
    assertAllowedKeys(step, ['id', 'op', 'query', 'path', 'limit']);
    const query = String(step.query || '').trim();
    if (!query || query.length > MAX_QUERY_LENGTH || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(query)) {
      throw apiError('REPO_QUERY_PLAN_QUERY_INVALID', `Search step '${id}' requires a bounded non-empty query.`);
    }
    return {
      id,
      op,
      refs: [],
      index,
      query,
      path: normalizeRelativePath(step.path, `steps[${index}].path`),
      limit: integerInRange(step.limit, 50, 1, MAX_SEARCH_LIMIT, 'REPO_QUERY_PLAN_LIMIT_INVALID', `steps[${index}].limit`),
    };
  }

  if (op === 'filter_path') {
    assertAllowedKeys(step, ['id', 'op', 'from', 'include', 'exclude']);
    const include = normalizePatternList(step.include, `steps[${index}].include`);
    const exclude = normalizePatternList(step.exclude, `steps[${index}].exclude`);
    if (include.length === 0 && exclude.length === 0) {
      throw apiError('REPO_QUERY_PLAN_FILTER_INVALID', `Filter step '${id}' requires include and/or exclude patterns.`);
    }
    return { id, op, refs: normalizeRefs(step.from, id), index, include, exclude };
  }

  if (op === 'dedupe') {
    assertAllowedKeys(step, ['id', 'op', 'from', 'by']);
    const by = step.by === undefined ? 'match' : String(step.by);
    if (by !== 'match' && by !== 'file') throw apiError('REPO_QUERY_PLAN_DEDUPE_INVALID', `Dedupe step '${id}' supports by='match' or by='file'.`);
    return { id, op, refs: normalizeRefs(step.from, id), index, by };
  }

  if (op === 'limit') {
    assertAllowedKeys(step, ['id', 'op', 'from', 'count']);
    return {
      id,
      op,
      refs: normalizeRefs(step.from, id),
      index,
      count: integerInRange(step.count, 25, 1, MAX_CANDIDATES, 'REPO_QUERY_PLAN_LIMIT_INVALID', `steps[${index}].count`),
    };
  }

  if (op === 'read_snippets') {
    assertAllowedKeys(step, ['id', 'op', 'from', 'contextBefore', 'contextAfter', 'maxBytesPerSnippet', 'maxTotalBytes']);
    return {
      id,
      op,
      refs: normalizeRefs(step.from, id),
      index,
      contextBefore: integerInRange(step.contextBefore, 2, 0, 50, 'REPO_QUERY_PLAN_SNIPPET_INVALID', `steps[${index}].contextBefore`),
      contextAfter: integerInRange(step.contextAfter, 2, 0, 50, 'REPO_QUERY_PLAN_SNIPPET_INVALID', `steps[${index}].contextAfter`),
      maxBytesPerSnippet: integerInRange(step.maxBytesPerSnippet, 4_000, 1, MAX_SNIPPET_BYTES, 'REPO_QUERY_PLAN_SNIPPET_INVALID', `steps[${index}].maxBytesPerSnippet`),
      maxTotalBytes: integerInRange(step.maxTotalBytes, 60_000, 1, MAX_READ_BYTES, 'REPO_QUERY_PLAN_SNIPPET_INVALID', `steps[${index}].maxTotalBytes`),
    };
  }

  assertAllowedKeys(step, ['id', 'op', 'from', 'fields']);
  const fields = step.fields === undefined ? [] : step.fields;
  if (!Array.isArray(fields) || fields.length > MAX_SELECTED_FIELDS) {
    throw apiError('REPO_QUERY_PLAN_SELECT_INVALID', `Select step '${id}' fields must contain at most ${MAX_SELECTED_FIELDS} entries.`);
  }
  const selectedFields = fields.map((entry) => String(entry || '').trim());
  if (selectedFields.some((field) => !SELECTABLE_FIELDS.has(field))) {
    throw apiError('REPO_QUERY_PLAN_SELECT_INVALID', `Select step '${id}' contains an unsupported evidence field.`);
  }
  return { id, op, refs: normalizeRefs(step.from, id), index, fields: selectedFields };
}

function validatePlan(args: Record<string, any>) {
  for (const key of Object.keys(args)) {
    if (EXECUTABLE_FIELD_NAMES.has(key.toLowerCase())) {
      throw apiError('REPO_QUERY_PLAN_EXECUTION_UNSUPPORTED', `Executable field '${key}' is not supported in Repo Query Plan V1.`);
    }
  }
  const rawSteps = Array.isArray(args.steps) ? args.steps : null;
  if (!rawSteps || rawSteps.length === 0) throw apiError('REPO_QUERY_PLAN_REQUIRED', 'steps must be a non-empty array.');
  if (rawSteps.length > MAX_STEPS) throw apiError('REPO_QUERY_PLAN_TOO_COMPLEX', `Repo Query Plan V1 supports at most ${MAX_STEPS} steps.`);
  const steps = rawSteps.map(normalizeStep);
  if (steps.filter((step) => step.op === 'search').length > MAX_SEARCH_STEPS) {
    throw apiError('REPO_QUERY_PLAN_TOO_COMPLEX', `Repo Query Plan V1 supports at most ${MAX_SEARCH_STEPS} search steps.`);
  }

  const byId = new Map<string, NormalizedStep>();
  for (const step of steps) {
    if (byId.has(step.id)) throw apiError('REPO_QUERY_PLAN_DUPLICATE_STEP_ID', `Duplicate step id '${step.id}'.`);
    byId.set(step.id, step);
  }
  for (const step of steps) {
    for (const ref of step.refs) {
      if (!byId.has(ref)) throw apiError('REPO_QUERY_PLAN_MISSING_REFERENCE', `Step '${step.id}' references missing step '${ref}'.`);
      if (ref === step.id) throw apiError('REPO_QUERY_PLAN_CYCLE', `Step '${step.id}' cannot reference itself.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const topo: NormalizedStep[] = [];
  const visit = (step: NormalizedStep) => {
    if (visited.has(step.id)) return;
    if (visiting.has(step.id)) throw apiError('REPO_QUERY_PLAN_CYCLE', `Repo Query Plan contains a cycle involving '${step.id}'.`);
    visiting.add(step.id);
    for (const ref of step.refs) visit(byId.get(ref)!);
    visiting.delete(step.id);
    visited.add(step.id);
    topo.push(step);
  };
  for (const step of steps) visit(step);

  const kinds = new Map<string, ValueKind>();
  for (const step of topo) {
    const dependencyKinds = step.refs.map((ref) => kinds.get(ref)!);
    if (['filter_path', 'dedupe', 'limit', 'read_snippets'].includes(step.op)
      && dependencyKinds.some((kind) => kind !== 'candidates')) {
      throw apiError('REPO_QUERY_PLAN_TYPE_MISMATCH', `Step '${step.id}' requires candidate-producing dependencies.`);
    }
    if (step.op === 'select' && dependencyKinds.some((kind) => kind === 'selection')) {
      throw apiError('REPO_QUERY_PLAN_TYPE_MISMATCH', `Select step '${step.id}' cannot consume another select step.`);
    }
    kinds.set(step.id, step.op === 'read_snippets' ? 'snippets' : step.op === 'select' ? 'selection' : 'candidates');
  }

  const output = String(args.output || '').trim();
  const outputStep = byId.get(output);
  if (!outputStep || outputStep.op !== 'select') {
    throw apiError('REPO_QUERY_PLAN_OUTPUT_INVALID', 'output must reference one select step in the plan.');
  }

  return {
    steps,
    byId,
    output,
    allowPartial: args.allowPartial === true || String(args.allowPartial).toLowerCase() === 'true',
    maxConcurrency: integerInRange(args.maxConcurrency, MAX_CONCURRENCY, 1, MAX_CONCURRENCY, 'REPO_QUERY_PLAN_CONCURRENCY_INVALID', 'maxConcurrency'),
    maxReturnedBytes: integerInRange(args.maxReturnedBytes, DEFAULT_RETURN_BYTES, 1_024, MAX_RETURN_BYTES, 'REPO_QUERY_PLAN_BYTES_INVALID', 'maxReturnedBytes'),
  };
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globRegex(pattern: string) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function candidateCompare(left: Evidence, right: Evidence) {
  return left.path.localeCompare(right.path)
    || Number(left.line || left.startLine || 0) - Number(right.line || right.startLine || 0)
    || String(left.preview || '').localeCompare(String(right.preview || ''));
}

function mergeInputs(refs: string[], outputs: Map<string, StepOutput>) {
  return refs.flatMap((ref) => outputs.get(ref)?.items || []).map((item) => ({ ...item })).sort(candidateCompare);
}

function normalizeError(step: NormalizedStep, error: unknown) {
  const payload = (error as any)?.payload;
  return {
    stepId: step.id,
    op: step.op,
    code: String(payload?.code || 'REPO_QUERY_PLAN_STEP_FAILED'),
    message: String(payload?.message || (error instanceof Error ? error.message : error || 'Step failed.')).slice(0, 300),
  };
}

function projectArgs(args: Record<string, any>) {
  return {
    projectId: args.projectId,
    projectName: args.projectName,
    repo: args.repo,
    repoUrl: args.repoUrl,
    localPath: args.localPath,
    sessionId: args.sessionId,
    workspaceId: args.workspaceId,
  };
}

function fitEvidenceToBudget(items: Evidence[], maxBytes: number) {
  const selected: Evidence[] = [];
  let truncated = false;
  for (const item of items) {
    const candidate = [...selected, item];
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) {
      selected.push(item);
      continue;
    }
    truncated = true;
  }
  return {
    evidence: selected,
    returnedBytes: Buffer.byteLength(JSON.stringify(selected), 'utf8'),
    truncated,
  };
}

export function createRepoQueryPlanExecutor(overrides: Partial<RepoQueryPlanDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function executeRepoQueryPlan(
    state: AppState,
    args: Record<string, any>,
    logger: Logger = { stdout: () => {}, stderr: () => {} },
    setCancelFn: SetCancelFn = () => {},
  ) {
    const totalStartedAt = deps.now();
    const validationStartedAt = deps.now();
    const plan = validatePlan(args);
    const validationMs = deps.now() - validationStartedAt;
    const activeCancels = new Set<() => void>();
    setCancelFn(() => {
      for (const cancel of [...activeCancels]) {
        try { cancel(); } catch {}
      }
    });

    const outputs = new Map<string, StepOutput>();
    const failed = new Set<string>();
    const pending = new Set(plan.steps.map((step) => step.id));
    const stepErrors: Array<{ stepId: string; op: string; code: string; message: string }> = [];
    const opCounts: Record<string, number> = {};
    const counters = {
      searchCount: 0,
      searchMatches: 0,
      filterCandidatesBefore: 0,
      filterCandidatesAfter: 0,
      dedupeCandidatesBefore: 0,
      dedupeCandidatesAfter: 0,
      limitCandidatesBefore: 0,
      limitCandidatesAfter: 0,
      snippetReadCount: 0,
      snippetReadBytes: 0,
    };
    const workTimings = { searchMs: 0, transformMs: 0, readMs: 0 };
    let executedStepCount = 0;
    let truncated = false;

    const pushError = (error: { stepId: string; op: string; code: string; message: string }) => {
      if (stepErrors.length < MAX_STEP_ERRORS) stepErrors.push(error);
    };

    const executeStep = async (step: NormalizedStep, refs: string[]): Promise<StepOutput> => {
      const startedAt = deps.now();
      opCounts[step.op] = (opCounts[step.op] || 0) + 1;
      executedStepCount += 1;

      if (step.op === 'search') {
        let cancel: (() => void) | null = null;
        try {
          const result = await deps.search(
            state,
            { ...projectArgs(args), query: step.query, path: step.path, limit: step.limit },
            logger,
            (fn) => {
              cancel = fn;
              activeCancels.add(fn);
            },
          );
          const items = (Array.isArray(result?.matches) ? result.matches : [])
            .slice(0, MAX_CANDIDATES)
            .map((match: any): Evidence => ({
              path: String(match.path || '').replace(/\\/g, '/'),
              line: Number.isFinite(Number(match.line)) ? Number(match.line) : undefined,
              preview: typeof match.preview === 'string' ? match.preview : undefined,
            }))
            .filter((item: Evidence) => item.path)
            .sort(candidateCompare);
          counters.searchCount += 1;
          counters.searchMatches += items.length;
          truncated ||= Boolean(result?.truncated) || Number(result?.count || 0) > items.length;
          return { kind: 'candidates', items };
        } finally {
          if (cancel) activeCancels.delete(cancel);
          workTimings.searchMs += deps.now() - startedAt;
        }
      }

      const input = mergeInputs(refs, outputs).slice(0, MAX_CANDIDATES);
      if (step.op === 'filter_path') {
        const include = (step.include as string[]).map(globRegex);
        const exclude = (step.exclude as string[]).map(globRegex);
        const items = input.filter((item) => {
          const normalized = item.path.replace(/\\/g, '/');
          const included = include.length === 0 || include.some((regex) => regex.test(normalized));
          const excluded = exclude.some((regex) => regex.test(normalized));
          return included && !excluded;
        });
        counters.filterCandidatesBefore += input.length;
        counters.filterCandidatesAfter += items.length;
        workTimings.transformMs += deps.now() - startedAt;
        return { kind: 'candidates', items };
      }

      if (step.op === 'dedupe') {
        const seen = new Set<string>();
        const items = input.filter((item) => {
          const key = step.by === 'file' ? item.path : `${item.path}:${item.line || 0}:${item.preview || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        counters.dedupeCandidatesBefore += input.length;
        counters.dedupeCandidatesAfter += items.length;
        workTimings.transformMs += deps.now() - startedAt;
        return { kind: 'candidates', items };
      }

      if (step.op === 'limit') {
        const items = input.slice(0, step.count);
        counters.limitCandidatesBefore += input.length;
        counters.limitCandidatesAfter += items.length;
        truncated ||= input.length > items.length;
        workTimings.transformMs += deps.now() - startedAt;
        return { kind: 'candidates', items };
      }

      if (step.op === 'read_snippets') {
        const candidates = input.slice(0, MAX_SNIPPETS);
        truncated ||= input.length > candidates.length;
        if (candidates.length === 0) {
          workTimings.readMs += deps.now() - startedAt;
          return { kind: 'snippets', items: [] };
        }
        const files = candidates.map((candidate) => {
          const line = Number(candidate.line || 0);
          return {
            filePath: candidate.path,
            ...(line > 0 ? {
              startLine: Math.max(1, line - step.contextBefore),
              endLine: line + step.contextAfter,
            } : {}),
            maxBytes: step.maxBytesPerSnippet,
            responseMode: 'compact',
          };
        });
        try {
          const result = deps.readSnippets(state, {
            ...projectArgs(args),
            files,
            maxFiles: MAX_SNIPPETS,
            maxTotalBytes: step.maxTotalBytes,
            allowPartial: plan.allowPartial,
            responseMode: 'compact',
          });
          const resultFiles = Array.isArray(result?.files) ? result.files : [];
          const items = resultFiles.flatMap((entry: any, index: number): Evidence[] => {
            if (entry?.ok === false) return [];
            const source = candidates[index] || { path: String(entry?.path || '') };
            return [{
              path: String(entry?.path || source.path || '').replace(/\\/g, '/'),
              line: source.line,
              preview: source.preview,
              startLine: Number.isFinite(Number(entry?.startLine)) ? Number(entry.startLine) : undefined,
              endLine: Number.isFinite(Number(entry?.endLine)) ? Number(entry.endLine) : undefined,
              content: typeof entry?.content === 'string' ? entry.content : undefined,
              returnedBytes: Number.isFinite(Number(entry?.returnedBytes)) ? Number(entry.returnedBytes) : undefined,
              truncated: entry?.truncated === true,
            }];
          }).filter((item: Evidence) => item.path).sort(candidateCompare);
          counters.snippetReadCount += items.length;
          counters.snippetReadBytes += Number(result?.totalReturnedBytes || 0);
          truncated ||= Boolean(result?.truncated);
          if (plan.allowPartial && Number(result?.errorCount || 0) > 0) {
            pushError({
              stepId: step.id,
              op: step.op,
              code: 'REPO_QUERY_PLAN_READ_PARTIAL',
              message: `${Number(result.errorCount)} snippet read(s) failed while partial results were allowed.`,
            });
          }
          return { kind: 'snippets', items };
        } finally {
          workTimings.readMs += deps.now() - startedAt;
        }
      }

      const fields = step.fields.length > 0
        ? step.fields as string[]
        : input.some((item) => typeof item.content === 'string')
          ? ['path', 'line', 'startLine', 'endLine', 'content', 'returnedBytes', 'truncated']
          : ['path', 'line', 'preview'];
      const items = input.map((item) => Object.fromEntries(fields.flatMap((field) => item[field as keyof Evidence] === undefined ? [] : [[field, item[field as keyof Evidence]]])) as Evidence);
      workTimings.transformMs += deps.now() - startedAt;
      return { kind: 'selection', items };
    };

    const executionStartedAt = deps.now();
    while (pending.size > 0) {
      const ready = plan.steps
        .filter((step) => pending.has(step.id) && step.refs.every((ref) => outputs.has(ref) || failed.has(ref)))
        .sort((left, right) => left.index - right.index);
      if (ready.length === 0) throw apiError('REPO_QUERY_PLAN_CYCLE', 'Repo Query Plan could not make dependency progress.');

      const runnable: Array<{ step: NormalizedStep; refs: string[] }> = [];
      for (const step of ready) {
        const availableRefs = step.refs.filter((ref) => outputs.has(ref));
        const missingRefs = step.refs.filter((ref) => failed.has(ref));
        if (missingRefs.length > 0 && !plan.allowPartial) {
          throw apiError('REPO_QUERY_PLAN_DEPENDENCY_FAILED', `Step '${step.id}' depends on failed step '${missingRefs[0]}'.`);
        }
        if (missingRefs.length > 0) {
          pushError({
            stepId: step.id,
            op: step.op,
            code: 'REPO_QUERY_PLAN_DEPENDENCY_PARTIAL',
            message: `Step '${step.id}' continued without failed dependencies: ${missingRefs.join(', ')}.`,
          });
        }
        if (step.refs.length > 0 && availableRefs.length === 0) {
          pending.delete(step.id);
          failed.add(step.id);
          pushError({
            stepId: step.id,
            op: step.op,
            code: 'REPO_QUERY_PLAN_DEPENDENCY_FAILED',
            message: `Step '${step.id}' had no successful dependency output.`,
          });
          continue;
        }
        runnable.push({ step, refs: availableRefs });
      }

      for (let offset = 0; offset < runnable.length; offset += plan.maxConcurrency) {
        const chunk = runnable.slice(offset, offset + plan.maxConcurrency);
        const settled = await Promise.all(chunk.map(async ({ step, refs }) => {
          try {
            return { step, output: await executeStep(step, refs), error: null as unknown };
          } catch (error) {
            return { step, output: null as StepOutput | null, error };
          }
        }));
        for (const result of settled) {
          pending.delete(result.step.id);
          if (!result.error && result.output) {
            outputs.set(result.step.id, result.output);
            continue;
          }
          if (!plan.allowPartial) throw result.error;
          failed.add(result.step.id);
          pushError(normalizeError(result.step, result.error));
        }
      }
    }
    const executionMs = deps.now() - executionStartedAt;

    const responseStartedAt = deps.now();
    const rawEvidence = outputs.get(plan.output)?.items || [];
    const fitted = fitEvidenceToBudget(rawEvidence, plan.maxReturnedBytes);
    truncated ||= fitted.truncated;
    const responseAssemblyMs = deps.now() - responseStartedAt;
    const totalMs = deps.now() - totalStartedAt;

    return {
      evidence: fitted.evidence,
      diagnostics: {
        plan: {
          stepCount: plan.steps.length,
          executedStepCount,
          outputStepId: plan.output,
          maxConcurrency: plan.maxConcurrency,
          operationCounts: opCounts,
        },
        counts: counters,
        returnedBytes: fitted.returnedBytes,
        truncated,
        partial: stepErrors.length > 0 || failed.size > 0,
        stepErrors,
        phaseTimingsMs: {
          validation: Math.round(validationMs * 100) / 100,
          execution: Math.round(executionMs * 100) / 100,
          searchWork: Math.round(workTimings.searchMs * 100) / 100,
          transformWork: Math.round(workTimings.transformMs * 100) / 100,
          readWork: Math.round(workTimings.readMs * 100) / 100,
          responseAssembly: Math.round(responseAssemblyMs * 100) / 100,
          total: Math.round(totalMs * 100) / 100,
        },
      },
    };
  };
}

export const executeRepoQueryPlan = createRepoQueryPlanExecutor();
