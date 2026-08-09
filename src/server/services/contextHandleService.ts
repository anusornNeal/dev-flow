import crypto, { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AppState } from '../types';
import { resolveProjectRoot } from './localFileService';
import { getMissingContextDelta, getRepoContextBundle, normalizeMissingContextRequest } from './projectStartContextService';
import { getRepoRevisionForRoot } from './repoRevisionService';
import { getRepoCacheLineage, recordRepoCacheAccess, registerRepoCacheInvalidator } from './repoCacheInvalidationService';

const HANDLE_TTL_MS = 5 * 60_000;
const MAX_HANDLES = 128;
const CONTEXT_HANDLE_DEPENDENCIES = ['repo-content', 'repo-revision', 'project-rules'] as const;

type ContextHandleEntry = {
  id: string;
  root: string;
  optionsHash: string;
  repoRevision: string;
  lineageToken: string;
  snippetRevisions: Map<string, string>;
  knownEvidenceRevisions: Map<string, string>;
  expiresAt: number;
};

const handles = new Map<string, ContextHandleEntry>();

registerRepoCacheInvalidator('context-handles', () => 0, {
  dependencies: [...CONTEXT_HANDLE_DEPENDENCIES],
});

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
    contextIntent: args.contextIntent ?? args.intent,
    complexity: args.complexity,
    targetFiles: Array.isArray(args.targetFiles) ? [...args.targetFiles].map(String).sort() : args.targetFiles,
    disclosureLevel: args.disclosureLevel ?? args.contextDepth ?? (args.fullFile === true ? 'full-file' : undefined),
    maxContextBytes: args.maxContextBytes ?? args.maxSnippetTotalBytes,
    deep: args.deep === true || args.deep === 'true',
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

function storeHandle(root: string, hash: string, bundle: any, existingId?: string, existingEntry?: ContextHandleEntry) {
  prune();
  const id = existingId || `ctx-${randomUUID()}`;
  const knownEvidenceRevisions = existingEntry?.knownEvidenceRevisions
    ? new Map(existingEntry.knownEvidenceRevisions)
    : new Map<string, string>();
  for (const snippet of bundle?.snippets || []) {
    const revision = String(snippet?.revision || snippet?.fileRevision?.token || '');
    const pathValue = String(snippet?.path || '').replace(/\\/g, '/');
    if (!revision || !pathValue) continue;
    const startLine = Number(snippet?.startLine || 1);
    const endLine = Number(snippet?.endLine || startLine);
    knownEvidenceRevisions.set(`snippet:${pathValue}:${startLine}:${endLine}`, revision);
  }
  const entry: ContextHandleEntry = {
    id,
    root: path.resolve(root),
    optionsHash: hash,
    repoRevision: String(bundle.repoRevision || ''),
    lineageToken: getRepoCacheLineage(root, [...CONTEXT_HANDLE_DEPENDENCIES]).token,
    snippetRevisions: snippetRevisionMap(bundle),
    knownEvidenceRevisions,
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
  const currentLineage = getRepoCacheLineage(root, [...CONTEXT_HANDLE_DEPENDENCIES]);
  const missingRequest = normalizeMissingContextRequest(args);

  if (existing && existing.root === root && existing.optionsHash === hash && missingRequest.requested) {
    recordRepoCacheAccess('context-handles', true, root);
    if (!missingRequest.specific) {
      existing.expiresAt = Date.now() + HANDLE_TTL_MS;
      return {
        status: 'not_modified' as const,
        reason: 'missing-context' as const,
        contextHandle: existing.id,
        repoRevision: existing.repoRevision,
        changedSnippets: [],
        changedRelationships: [],
        removedPaths: [],
        missingContext: { status: 'specific-evidence-required' as const, request: missingRequest },
        metrics: { returnedBytes: 0, estimatedTokens: 0, knownEvidenceSkipped: 0, followUpCalls: 0, recoverySuccess: false },
      };
    }

    const delta = getMissingContextDelta(state, args);
    let revision;
    try {
      revision = getRepoRevisionForRoot(root);
    } catch {
      revision = undefined;
    }
    const freshSnippets = (delta.snippets || []).filter((snippet: any) => {
      const key = String(snippet.evidenceKey || '');
      const value = String(snippet.revision || snippet.fileRevision?.token || '');
      return key && value && existing.knownEvidenceRevisions.get(key) !== value;
    });
    const relationshipRevision = String(revision?.token || existing.repoRevision || '');
    const freshRelationships = (delta.relationships || []).filter((entry: any) => {
      const key = String(entry.evidenceKey || '');
      return key && relationshipRevision && existing.knownEvidenceRevisions.get(key) !== relationshipRevision;
    });
    const knownEvidenceSkipped = (delta.snippets?.length || 0) + (delta.relationships?.length || 0) - freshSnippets.length - freshRelationships.length;
    for (const snippet of freshSnippets) {
      existing.knownEvidenceRevisions.set(String(snippet.evidenceKey), String(snippet.revision || snippet.fileRevision?.token || ''));
    }
    for (const relationship of freshRelationships) {
      existing.knownEvidenceRevisions.set(String(relationship.evidenceKey), relationshipRevision);
    }
    const currentRepoRevision = String(revision?.token || existing.repoRevision || '');
    existing.lineageToken = getRepoCacheLineage(root, [...CONTEXT_HANDLE_DEPENDENCIES]).token;
    existing.expiresAt = Date.now() + HANDLE_TTL_MS;
    handles.delete(existing.id);
    handles.set(existing.id, existing);
    const returnedBytes = freshSnippets.reduce((total: number, snippet: any) => total + Number(snippet.returnedBytes || 0), 0)
      + Buffer.byteLength(JSON.stringify(freshRelationships), 'utf8');
    const hasFreshEvidence = freshSnippets.length > 0 || freshRelationships.length > 0;
    return {
      status: hasFreshEvidence ? 'delta' as const : 'not_modified' as const,
      reason: 'missing-context' as const,
      contextHandle: existing.id,
      repoRevision: currentRepoRevision,
      changedSnippets: freshSnippets,
      changedRelationships: freshRelationships,
      removedPaths: [],
      missingContext: { status: delta.status, request: delta.request, budget: delta.budget },
      metrics: {
        returnedBytes,
        estimatedTokens: Math.ceil(returnedBytes / 4),
        knownEvidenceSkipped,
        followUpCalls: 1,
        recoverySuccess: delta.status === 'resolved',
      },
    };
  }

  if (existing && existing.root === root && existing.optionsHash === hash) {
    let revision;
    try {
      revision = getRepoRevisionForRoot(root);
    } catch {
      revision = undefined;
    }
    if (revision && revision.token === existing.repoRevision && existing.lineageToken === currentLineage.token) {
      existing.expiresAt = Date.now() + HANDLE_TTL_MS;
      handles.delete(existing.id);
      handles.set(existing.id, existing);
      recordRepoCacheAccess('context-handles', true, root);
      return {
        status: 'not_modified' as const,
        contextHandle: existing.id,
        repoRevision: existing.repoRevision,
        changedSnippets: [],
        removedPaths: [],
      };
    }
  }

  recordRepoCacheAccess('context-handles', false, root);
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
  const stored = storeHandle(root, hash, bundle, existing.id, existing);

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
