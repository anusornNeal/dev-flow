import fs from 'node:fs';
import path from 'node:path';
import { recordRepoChanges } from './repoChangeJournalService';

const IGNORED_TOP_LEVEL = new Set(['.git', '.devflow', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.vite', '.idea', '.vscode']);
const FLUSH_DELAY_MS = 40;

type WatcherState = {
  root: string;
  watcher?: fs.FSWatcher;
  active: boolean;
  degraded: boolean;
  error?: string;
  pending: Set<string>;
  timer?: NodeJS.Timeout;
};

const watchers = new Map<string, WatcherState>();

function normalizeRoot(root: string) {
  return path.resolve(root);
}

function normalizeRelativePath(root: string, filename: string | Buffer | null) {
  if (!filename) return '';
  const raw = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename;
  const relative = path.isAbsolute(raw) ? path.relative(root, raw) : raw;
  return relative.replace(/\\/g, '/').replace(/^\.\//, '');
}

function shouldIgnore(relativePath: string) {
  const first = relativePath.split('/').filter(Boolean)[0] || '';
  return !first || IGNORED_TOP_LEVEL.has(first);
}

function flush(state: WatcherState) {
  state.timer = undefined;
  const paths = Array.from(state.pending);
  state.pending.clear();
  if (paths.length > 0) recordRepoChanges(state.root, paths, 'filesystem-watcher');
}

function schedule(state: WatcherState, relativePath: string) {
  if (!relativePath || shouldIgnore(relativePath)) return;
  state.pending.add(relativePath);
  if (state.timer) return;
  state.timer = setTimeout(() => flush(state), FLUSH_DELAY_MS);
  state.timer.unref?.();
}

export function ensureRepoChangeWatcher(root: string) {
  const normalized = normalizeRoot(root);
  const existing = watchers.get(normalized);
  if (existing) {
    return { root: normalized, active: existing.active, degraded: existing.degraded, error: existing.error };
  }

  const state: WatcherState = { root: normalized, active: false, degraded: false, pending: new Set() };
  watchers.set(normalized, state);

  try {
    const watcher = fs.watch(normalized, { recursive: true }, (_eventType, filename) => {
      schedule(state, normalizeRelativePath(normalized, filename));
    });
    watcher.on('error', (error) => {
      state.active = false;
      state.degraded = true;
      state.error = error.message;
    });
    state.watcher = watcher;
    state.active = true;
  } catch (error) {
    state.degraded = true;
    state.error = error instanceof Error ? error.message : String(error);
  }

  return { root: normalized, active: state.active, degraded: state.degraded, error: state.error };
}

export function getRepoChangeWatcherStatus(root: string) {
  const normalized = normalizeRoot(root);
  const state = watchers.get(normalized);
  if (!state) return { root: normalized, active: false, degraded: false, started: false };
  return { root: normalized, active: state.active, degraded: state.degraded, error: state.error, started: true };
}

export function stopRepoChangeWatcher(root: string) {
  const normalized = normalizeRoot(root);
  const state = watchers.get(normalized);
  if (!state) return false;
  if (state.timer) clearTimeout(state.timer);
  flush(state);
  state.watcher?.close();
  watchers.delete(normalized);
  return true;
}

export function stopAllRepoChangeWatchers() {
  const roots = Array.from(watchers.keys());
  for (const root of roots) stopRepoChangeWatcher(root);
  return roots.length;
}
