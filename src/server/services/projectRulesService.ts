import fs from 'fs';
import path from 'path';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';

const FILE_CACHE_TTL_MS = 30_000;

interface FileCacheEntry {
  data: ProjectRulesContext;
  mtimeMs: number;
  cachedAt: number;
}

let fileCache: FileCacheEntry | null = null;

export interface ProjectFileRules {
  ignoreDirectories: string[];
  includeDirectories: string[];
  maxFileBytes: number;
  maxFiles: number;
}

export interface ProjectRulesContext {
  title: string;
  workflow: string[];
  files: ProjectFileRules;
}

const SAFE_DEFAULT_FILE_RULES: ProjectFileRules = {
  ignoreDirectories: [
    '.git',
    'node_modules',
    'build',
    'dist',
    '.gradle',
    '.idea',
    '.devflow',
    '.agents',
    'coverage',
    '.next',
    '.turbo',
    '.cache',
    'out',
    'tmp',
    'temp',
  ],
  includeDirectories: ['.github'],
  maxFileBytes: 100_000,
  maxFiles: 2_500,
};

const FALLBACK_PROJECT_RULES: ProjectRulesContext = {
  title: 'DevFlow Workflow Rules',
  workflow: [
    'Move todo cards to in-progress before implementation starts.',
    'Use the card branch. If the card has no branch, default to develop.',
    'Handle every checklist item or mini task.',
    'Do not silently skip checklist items. If an item is not applicable, report the reason.',
    'When implementation is complete, push the work to the active branch first.',
    'Push the work to the active branch before moving the card to ready-for-review.',
    'Do not move a card to ready-for-review before code is pushed.',
  ],
  files: SAFE_DEFAULT_FILE_RULES,
};

function normalizeRules(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const rules = value
    .map((rule) => typeof rule === 'string' ? rule.trim() : '')
    .filter(Boolean);
  return rules.length > 0 ? rules : fallback;
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim().replace(/\\/g, '/') : '')
    .map((item) => item.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .filter((item) => !item.split('/').includes('..'));
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function mergeProjectFileRules(value: unknown): ProjectFileRules {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const requestedIgnores = normalizeStringArray(raw.ignoreDirectories ?? raw.ignoredDirectories ?? raw.skipDirectories);
  const requestedIncludes = normalizeStringArray(raw.includeDirectories ?? raw.allowedDotDirectories);
  const includeSet = new Set([...SAFE_DEFAULT_FILE_RULES.includeDirectories, ...requestedIncludes]);
  const ignoreDirectories = uniqueSorted([
    ...SAFE_DEFAULT_FILE_RULES.ignoreDirectories,
    ...requestedIgnores,
  ]).filter((dir) => !includeSet.has(dir));

  return {
    ignoreDirectories,
    includeDirectories: uniqueSorted(Array.from(includeSet)),
    maxFileBytes: boundedNumber(raw.maxFileBytes, SAFE_DEFAULT_FILE_RULES.maxFileBytes, 1_000, 1_000_000),
    maxFiles: boundedNumber(raw.maxFiles, SAFE_DEFAULT_FILE_RULES.maxFiles, 1, 10_000),
  };
}

export function getProjectRulesContext(baseDir = getDevFlowAppRoot()): ProjectRulesContext {
  const rulesPath = path.join(baseDir, 'config', 'project-rules.json');

  // Try cache first
  try {
    const stat = fs.statSync(rulesPath);
    const now = Date.now();
    if (
      fileCache &&
      fileCache.mtimeMs === stat.mtimeMs &&
      now - fileCache.cachedAt < FILE_CACHE_TTL_MS
    ) {
      return fileCache.data;
    }
  } catch {
    // File doesn't exist, use fallback
    if (fileCache) return fileCache.data;
    return FALLBACK_PROJECT_RULES;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const data: ProjectRulesContext = {
      title: typeof parsed?.title === 'string' && parsed.title.trim()
        ? parsed.title.trim()
        : FALLBACK_PROJECT_RULES.title,
      workflow: normalizeRules(parsed?.workflow, FALLBACK_PROJECT_RULES.workflow),
      files: mergeProjectFileRules(parsed?.files),
    };
    fileCache = { data, mtimeMs: fs.statSync(rulesPath).mtimeMs, cachedAt: Date.now() };
    return data;
  } catch (error) {
    console.error('Error parsing project-rules.json', error);
    return FALLBACK_PROJECT_RULES;
  }
}
