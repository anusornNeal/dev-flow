import type { AtlasFreshness, ProjectAtlas } from '../../types.js';
import {
  isAtlasStale,
  readAtlasCache,
  shouldRefreshAtlasForDailyOpen,
  writeAtlasCache,
} from './projectAtlasCacheService.js';

export function readLatestAtlas(projectId: string) {
  return readAtlasCache({ projectId });
}

export function saveLatestAtlas(atlas: ProjectAtlas) {
  return writeAtlasCache({ atlas });
}

export function getAtlasFreshness(projectId: string) {
  return readLatestAtlas(projectId).atlas.freshness;
}

export function getAtlasRefreshStatus(
  freshness: AtlasFreshness,
  input: { now?: string; repoFingerprint?: string; manualRescan?: boolean } = {},
) {
  const stale = isAtlasStale(freshness, input);
  return {
    stale,
    dailyOpenRefreshEligible: shouldRefreshAtlasForDailyOpen(
      stale ? { ...freshness, status: freshness.status === 'fresh' ? 'stale' : freshness.status } : freshness,
      { now: input.now },
    ),
  };
}
