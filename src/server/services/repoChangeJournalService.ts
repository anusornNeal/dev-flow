import path from 'node:path';

const MAX_EVENTS_PER_REPO = 1000;

export type RepoChangeJournalEvent = {
  sequence: number;
  paths: string[];
  reason?: string;
  recordedAt: string;
};

type RepoJournalState = {
  sequence: number;
  events: RepoChangeJournalEvent[];
};

const journals = new Map<string, RepoJournalState>();

function normalizeRoot(root: string) {
  return path.resolve(root);
}

function normalizePath(value: string) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function getState(root: string) {
  const key = normalizeRoot(root);
  let state = journals.get(key);
  if (!state) {
    state = { sequence: 0, events: [] };
    journals.set(key, state);
  }
  return state;
}

export function recordRepoChanges(root: string, paths: string[], reason?: string) {
  const state = getState(root);
  const normalizedPaths = Array.from(new Set(paths.map(normalizePath).filter(Boolean))).sort();
  state.sequence += 1;
  const event: RepoChangeJournalEvent = {
    sequence: state.sequence,
    paths: normalizedPaths,
    reason,
    recordedAt: new Date().toISOString(),
  };
  state.events.push(event);
  if (state.events.length > MAX_EVENTS_PER_REPO) {
    state.events.splice(0, state.events.length - MAX_EVENTS_PER_REPO);
  }
  return event;
}

export function getRepoChangesSince(root: string, sinceSequence = 0) {
  const state = getState(root);
  const oldestSequence = state.events[0]?.sequence ?? state.sequence + 1;
  const uncertain = sinceSequence < oldestSequence - 1;
  const events = uncertain ? state.events : state.events.filter((event) => event.sequence > sinceSequence);
  const paths = Array.from(new Set(events.flatMap((event) => event.paths))).sort();
  return {
    root: normalizeRoot(root),
    sinceSequence,
    sequence: state.sequence,
    oldestSequence,
    uncertain,
    paths,
    events,
  };
}

export function getRepoChangeJournalSequence(root: string) {
  return getState(root).sequence;
}

export function clearRepoChangeJournal(root?: string) {
  if (!root) {
    const count = journals.size;
    journals.clear();
    return count;
  }
  return journals.delete(normalizeRoot(root)) ? 1 : 0;
}
