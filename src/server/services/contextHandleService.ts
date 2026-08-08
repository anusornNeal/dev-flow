import crypto, { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AppState } from '../types';
import { resolveProjectRoot } from './localFileService';
import { getRepoContextBundle } from './projectStartContextService';
import { getRepoRevisionForRoot } from './repoRevisionService';

const HANDLE_TTL_MS = 5 * 60_000;
const MAX_HANDLES = 128;

type ContextHandleEntry = {
  id: string;
  root: string;
  optionsHash: string;
  repoRevision: string;
  snippetRevisions: Map<string, string>;
  expiresAt: number;
};

const handles = new Map<string, ContextHandleEntry>();

function prune(now = Date.now()) {
  for (const [id, entry] of handles) {
    if (entry.expiresAt <= now) handles.delete(id);
  }
  while (handles.size >= MAX_HANDLES) {
    const oldest = handles.keys().next().value;
    if (!oldest) break;
    handles.delete(oldest);
  }
}

function optionsHash(args: Record<string, any>) {
  const relevant = {
    q: args.q ?? args.query ?? '',
    path: args.path ?? '.',
    limit: args.limit,
    snippetLimit: args.snippetLimit,
    snippetLines: args.snippetLines,
    maxSnippetBytes: args.maxSnippetBytes,
    includeDiff: args.includeDiff === true,
    diffPath: args.diffPath,
    maxDiffBytes: args.maxDiffBytes,
    includeIgnored: args.includeIgnored === true,
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

function snippetRevisionMap(bundle: any) {
  const map = new Map<string, string>();
  for (const snippet of bundle?.snippets || []) {
    const revision = String(snippet?.revision || snippet?.fileRevision?.token || '');
    if (snippet?.path && revision) map.set(String(snippet.path).replace(/\\/g, '/'), revision);
  }
  return map;
}

function storeHandle(root: string, hash: string, bundle: any, existingId?: string) {
  prune();
  const id = existingId || `ctx-${randomUUID()}`;
  const entry: ContextHandleEntry = {
    id,
    root: path.resolve(root),
    optionsHash: hash,
    repoRevision: String(bundle.repoRevision || ''),
    snippetRevisions: snippetRevisionMap(bundle),
    expiresAt: Date.now() + HANDLE_TTL_MS,
  };
  handles.delete(id);
  handles.set(id, entry);
  return entry;
}

export function clearContextHandles() {
  const count = handles.size;
  handles.clear();
  return count;
}

export function getRepoContextWithHandle(state: AppState, args: Record<string, any>) {
  const root = path.resolve(resolveProjectRoot(state, args));
  const hash = optionsHash(args);
  const requestedHandle = typeof args.contextHandle === 'string' ? args.contextHandle.trim() : '';
  prune();
  const existing = requestedHandle ? handles.get(requestedHandle) : undefined;

  if (existing && existing.root === root && existing.optionsHash === hash) {
    let revision;
    try {
      revision = getRepoRevisionForRoot(root);
    } catch {
      revision = undefined;
    }
    if (revision && revision.token === existing.repoRevision) {
      existing.expiresAt = Date.now() + HANDLE_TTL_MS;
      handles.delete(existing.id);
      handles.set(existing.id, existing);
      return {
        status: 'not_modified' as const,
        contextHandle: existing.id,
        repoRevision: existing.repoRevision,
        changedSnippets: [],
        removedPaths: [],
      };
    }
  }

  const bundle = getRepoContextBundle(state, args);
  if (!existing || existing.root !== root || existing.optionsHash !== hash) {
    const stored = storeHandle(root, hash, bundle);
    return {
      status: 'full' as const,
      contextHandle: stored.id,
      repoRevision: stored.repoRevision,
      bundle,
      changedSnippets: bundle.snippets || [],
      removedPaths: [],
    };
  }

  const nextRevisions = snippetRevisionMap(bundle);
  const changedSnippets = (bundle.snippets || []).filter((snippet: any) => {
    const normalizedPath = String(snippet.path || '').replace(/\\/g, '/');
    const revision = String(snippet.revision || snippet.fileRevision?.token || '');
    return existing.snippetRevisions.get(normalizedPath) !== revision;
  });
  const removedPaths = Array.from(existing.snippetRevisions.keys()).filter((filePath) => !nextRevisions.has(filePath));
  const stored = storeHandle(root, hash, bundle, existing.id);

  return {
    status: 'delta' as const,
    contextHandle: stored.id,
    repoRevision: stored.repoRevision,
    changedSnippets,
    removedPaths,
    git: bundle.git,
    diff: bundle.diff,
    index: {
      cache: bundle.index?.cache,
      generatedAt: bundle.index?.generatedAt,
      count: bundle.index?.count,
    },
  };
}

export function getContextHandleStats() {
  prune();
  return { entries: handles.size, maxEntries: MAX_HANDLES, ttlMs: HANDLE_TTL_MS };
}
