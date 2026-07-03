import fs from 'node:fs';
import path from 'node:path';
import { getProjectAtlasCachePath } from '../../lib/devFlowPaths.js';
import type { AtlasFreshness, AtlasScanMode, ProjectAtlas } from '../../types.js';

export type AtlasCacheReadStatus = 'ok' | 'missing' | 'invalid';

export interface AtlasCacheReadResult {
  status: AtlasCacheReadStatus;
  atlas: ProjectAtlas;
  path: string;
  error?: string;
}

export interface BuildEmptyAtlasInput {
  projectId: string;
  generatedAt?: string;
  repoFingerprint?: string;
  scanMode?: AtlasScanMode;
}

export interface ReadAtlasCacheInput {
  projectId: string;
}

export interface WriteAtlasCacheInput {
  atlas: ProjectAtlas;
}

export interface AtlasFreshnessCheckInput {
  now?: string;
  repoFingerprint?: string;
  manualRescan?: boolean;
  maxAgeMs?: number;
}

const DEFAULT_ATLAS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function buildEmptyProjectAtlas(input: BuildEmptyAtlasInput): ProjectAtlas {
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    nodes: [],
    edges: [],
    domains: [],
    flows: [],
    summary: {},
    freshness: {
      generatedAt: input.generatedAt,
      repoFingerprint: input.repoFingerprint,
      scanMode: input.scanMode,
      status: input.generatedAt ? 'fresh' : 'not-generated',
    },
  };
}

export function readAtlasCache(input: ReadAtlasCacheInput): AtlasCacheReadResult {
  const cachePath = getProjectAtlasCachePath(input.projectId);
  if (!fs.existsSync(cachePath)) {
    return { status: 'missing', atlas: buildEmptyProjectAtlas({ projectId: input.projectId }), path: cachePath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as ProjectAtlas;
    return { status: 'ok', atlas: normalizeProjectAtlas(parsed, input.projectId), path: cachePath };
  } catch (error) {
    return {
      status: 'invalid',
      atlas: buildEmptyProjectAtlas({ projectId: input.projectId }),
      path: cachePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeAtlasCache(input: WriteAtlasCacheInput) {
  const cachePath = getProjectAtlasCachePath(input.atlas.projectId);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(input.atlas, null, 2)}\n`, 'utf8');
  return { path: cachePath };
}

export function markAtlasDailyOpenChecked(projectId: string, now = new Date().toISOString()) {
  const cached = readAtlasCache({ projectId });
  const atlas = {
    ...cached.atlas,
    freshness: {
      ...cached.atlas.freshness,
      lastDailyOpenCheckedAt: now,
    },
  };
  writeAtlasCache({ atlas });
  return { status: cached.status, atlas };
}

export function isAtlasStale(freshness: AtlasFreshness, input: AtlasFreshnessCheckInput = {}) {
  if (input.manualRescan) return true;
  if (freshness.status === 'not-generated' || freshness.status === 'error' || freshness.status === 'stale') return true;
  if (input.repoFingerprint && freshness.repoFingerprint && input.repoFingerprint !== freshness.repoFingerprint) return true;
  if (!freshness.generatedAt) return true;

  const generatedAtMs = Date.parse(freshness.generatedAt);
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(nowMs)) return true;

  return nowMs - generatedAtMs > (input.maxAgeMs ?? DEFAULT_ATLAS_MAX_AGE_MS);
}

export function shouldRefreshAtlasForDailyOpen(freshness: AtlasFreshness, input: Pick<AtlasFreshnessCheckInput, 'now'> = {}) {
  if (freshness.status !== 'stale' && freshness.status !== 'not-generated' && freshness.status !== 'error') return false;
  if (!freshness.lastDailyOpenCheckedAt) return true;

  const nowDay = toUtcDay(input.now ?? new Date().toISOString());
  const lastCheckedDay = toUtcDay(freshness.lastDailyOpenCheckedAt);
  return nowDay !== lastCheckedDay;
}

function normalizeProjectAtlas(value: Partial<ProjectAtlas>, fallbackProjectId: string): ProjectAtlas {
  return {
    schemaVersion: 1,
    projectId: typeof value.projectId === 'string' ? value.projectId : fallbackProjectId,
    nodes: Array.isArray(value.nodes) ? value.nodes : [],
    edges: Array.isArray(value.edges) ? value.edges : [],
    domains: Array.isArray(value.domains) ? value.domains : [],
    flows: Array.isArray(value.flows) ? value.flows : [],
    summary: value.summary ?? {},
    freshness: value.freshness ?? { status: 'not-generated' },
  };
}

function toUtcDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
