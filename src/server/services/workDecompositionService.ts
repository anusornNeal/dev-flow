export type DecompositionUncertainty = 'low' | 'medium' | 'high';
export type DecompositionConflictRisk = 'low' | 'medium' | 'high';
export type DecompositionEdgeKind = 'prerequisite' | 'verification' | 'conflict-serialization';

export interface DecompositionRepoMatch {
  path: string;
  extension?: string;
  symbols?: string[];
  imports?: string[];
  score?: number;
}

export interface DecompositionRepoEvidence {
  repoRevision?: string;
  matches?: DecompositionRepoMatch[];
}

export interface DecompositionSessionEvidence {
  repoRevision?: string;
  inspectedFiles?: Array<{ path: string; symbols?: string[]; revision?: string }>;
  changedFiles?: string[];
  verificationFiles?: string[];
}

export interface DecompositionAtlasEvidence {
  stale?: boolean;
  matchedNodeIds?: string[];
  relatedTests?: string[];
  warnings?: Array<string | { code?: string; message?: string }>;
  recommendedReadOrder?: string[];
}

export interface BuildWorkDecompositionInput {
  title: string;
  description?: string;
  reasoning?: string;
  repoContext?: string;
  targetFiles?: string[];
  verification?: string;
  repoEvidence?: DecompositionRepoEvidence;
  atlasEvidence?: DecompositionAtlasEvidence;
  sessionEvidence?: DecompositionSessionEvidence;
}

export interface DecompositionEvidenceReason {
  source: 'explicit-target' | 'repo-index' | 'atlas' | 'session' | 'verification';
  path?: string;
  symbol?: string;
  reason: string;
  revision?: string;
}

export interface WorkDecompositionNode {
  id: string;
  title: string;
  kind: 'discovery' | 'contract' | 'migration' | 'api' | 'backend' | 'frontend' | 'implementation' | 'verification';
  targetFiles: string[];
  targetSymbols: string[];
  evidence: DecompositionEvidenceReason[];
  dependsOn: string[];
  uncertainty: DecompositionUncertainty;
  conflictRisk: DecompositionConflictRisk;
  verificationOwnership: string[];
  blockers: string[];
  runnable: boolean;
}

export interface WorkDecompositionEdge {
  from: string;
  to: string;
  kind: DecompositionEdgeKind;
  reason: string;
}

export interface WorkDecompositionResult {
  schemaVersion: 1;
  repoRevision?: string;
  nodes: WorkDecompositionNode[];
  edges: WorkDecompositionEdge[];
  runnableNow: string[];
  blocked: Array<{ nodeId: string; reason: string }>;
  parallelGroups: string[][];
  warnings: string[];
}

type BucketId = 'contract' | 'migration' | 'api' | 'backend' | 'frontend' | 'implementation' | 'verification';

type Candidate = {
  path: string;
  bucket: BucketId;
  symbols: string[];
  score: number;
  explicit: boolean;
  test: boolean;
  reasons: DecompositionEvidenceReason[];
};

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:\.test\.|\.spec\.)/i;
const CONTRACT_PATH = /(?:contract|dto|schema|types?)(?:s)?(?:\/|\.|$)/i;
const MIGRATION_PATH = /(?:migration|migrations|schema\.sql|db\/schema)/i;
const FRONTEND_PATH = /(?:^|\/)(?:components?|pages?|screens?|views?|ui|app)(?:\/|$)|\.(?:tsx|jsx)$/i;
const API_PATH = /(?:^|\/)(?:routes?|controllers?|handlers?|api)(?:\/|$)/i;
const BACKEND_PATH = /(?:^|\/)(?:services?|repositories?|usecases?|useCases|db|server)(?:\/|$)/i;

function normalizePath(value: unknown) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function inferBucket(filePath: string, inputText: string): BucketId {
  if (TEST_PATH.test(filePath)) return 'verification';
  if (MIGRATION_PATH.test(filePath) || /\bmigrat(?:e|ion)|database schema|schema change\b/i.test(inputText) && /schema|migration/i.test(filePath)) return 'migration';
  if (CONTRACT_PATH.test(filePath)) return 'contract';
  if (FRONTEND_PATH.test(filePath)) return 'frontend';
  if (API_PATH.test(filePath)) return 'api';
  if (BACKEND_PATH.test(filePath)) return 'backend';
  return 'implementation';
}

function candidateMap(input: BuildWorkDecompositionInput) {
  const explicitTargets = uniqueSorted((input.targetFiles || []).map(normalizePath));
  const explicitSet = new Set(explicitTargets);
  const text = [input.title, input.description, input.reasoning, input.repoContext].filter(Boolean).join(' ');
  const revision = input.repoEvidence?.repoRevision;
  const candidates = new Map<string, Candidate>();

  for (const filePath of explicitTargets) {
    candidates.set(filePath, {
      path: filePath,
      bucket: inferBucket(filePath, text),
      symbols: [],
      score: 100,
      explicit: true,
      test: TEST_PATH.test(filePath),
      reasons: [{
        source: 'explicit-target',
        path: filePath,
        reason: 'Selected because the task declares this explicit target file.',
        revision,
      }],
    });
  }

  for (const match of input.repoEvidence?.matches || []) {
    const filePath = normalizePath(match.path);
    if (!filePath) continue;
    const existing = candidates.get(filePath);
    const symbols = uniqueSorted((match.symbols || []).map(String));
    const score = Number.isFinite(match.score) ? Number(match.score) : 1;
    const repoReasons: DecompositionEvidenceReason[] = [
      {
        source: 'repo-index',
        path: filePath,
        reason: `Repo index matched this file with score ${score}.`,
        revision,
      },
      ...symbols.slice(0, 6).map((symbol) => ({
        source: 'repo-index' as const,
        path: filePath,
        symbol,
        reason: `Repo index surfaced symbol ${symbol}.`,
        revision,
      })),
    ];
    if (existing) {
      existing.symbols = uniqueSorted([...existing.symbols, ...symbols]);
      existing.score = Math.max(existing.score, score);
      existing.reasons.push(...repoReasons);
    } else {
      candidates.set(filePath, {
        path: filePath,
        bucket: inferBucket(filePath, text),
        symbols,
        score,
        explicit: explicitSet.has(filePath),
        test: TEST_PATH.test(filePath),
        reasons: repoReasons,
      });
    }
  }

  for (const testPath of input.atlasEvidence?.relatedTests || []) {  for (const sessionFile of input.sessionEvidence?.inspectedFiles || []) {
    const filePath = normalizePath(sessionFile.path);
    if (!filePath) continue;
    const existing = candidates.get(filePath);
    const symbols = uniqueSorted((sessionFile.symbols || []).map(String));
    const reason: DecompositionEvidenceReason = {
      source: 'session',
      path: filePath,
      reason: 'Execution-session evidence previously inspected this file.',
      revision: sessionFile.revision || input.sessionEvidence?.repoRevision || revision,
    };
    if (existing) {
      existing.symbols = uniqueSorted([...existing.symbols, ...symbols]);
      existing.score = Math.max(existing.score, 7);
      existing.reasons.push(reason);
    } else {
      candidates.set(filePath, {
        path: filePath,
        bucket: inferBucket(filePath, text),
        symbols,
        score: 7,
        explicit: false,
        test: TEST_PATH.test(filePath),
        reasons: [reason],
      });
    }
  }

  for (const changedFile of input.sessionEvidence?.changedFiles || []) {
    const filePath = normalizePath(changedFile);
    if (!filePath) continue;
    const existing = candidates.get(filePath);
    const reason: DecompositionEvidenceReason = {
      source: 'session',
      path: filePath,
      reason: 'Execution-session evidence marks this file as changed in the current work scope.',
      revision: input.sessionEvidence?.repoRevision || revision,
    };
    if (existing) {
      existing.score = Math.max(existing.score, 8);
      existing.reasons.push(reason);
    } else {
      candidates.set(filePath, {
        path: filePath,
        bucket: inferBucket(filePath, text),
        symbols: [],
        score: 8,
        explicit: false,
        test: TEST_PATH.test(filePath),
        reasons: [reason],
      });
    }
  }

  for (const verificationFile of input.sessionEvidence?.verificationFiles || []) {
    const filePath = normalizePath(verificationFile);
    if (!filePath) continue;
    const existing = candidates.get(filePath);
    const reason: DecompositionEvidenceReason = {
      source: 'verification',
      path: filePath,
      reason: 'Execution-session evidence associates this file with verification ownership.',
      revision: input.sessionEvidence?.repoRevision || revision,
    };
    if (existing) existing.reasons.push(reason);
    else candidates.set(filePath, {
      path: filePath,
      bucket: 'verification',
      symbols: [],
      score: 7,
      explicit: false,
      test: true,
      reasons: [reason],
    });
  }


    const filePath = normalizePath(testPath);
    if (!filePath) continue;
    const existing = candidates.get(filePath);
    const reason: DecompositionEvidenceReason = {
      source: 'atlas',
      path: filePath,
      reason: 'Project Atlas linked this test to the affected area.',
      revision,
    };
    if (existing) existing.reasons.push(reason);
    else candidates.set(filePath, {
      path: filePath,
      bucket: 'verification',
      symbols: [],
      score: 6,
      explicit: false,
      test: true,
      reasons: [reason],
    });
  }

  return Array.from(candidates.values())
    .sort((left, right) => Number(right.explicit) - Number(left.explicit) || right.score - left.score || left.path.localeCompare(right.path));
}

function candidateUncertainty(candidate: Candidate, hasAnyEvidence: boolean, atlasStale: boolean): DecompositionUncertainty {
  if (candidate.explicit) return atlasStale ? 'medium' : 'low';
  if (!hasAnyEvidence || candidate.score <= 1) return 'high';
  if (candidate.score >= 6 && !atlasStale) return 'low';
  return 'medium';
}

function bucketTitle(bucket: BucketId) {
  switch (bucket) {
    case 'contract': return 'Define shared contract';
    case 'migration': return 'Apply migration or persistence change';
    case 'api': return 'Update API or route boundary';
    case 'backend': return 'Implement backend/data behavior';
    case 'frontend': return 'Implement frontend/UI behavior';
    case 'verification': return 'Verify integrated behavior';
    default: return 'Implement focused change';
  }
}

function nodeConflictRisk(bucket: BucketId, files: Candidate[], allImplementationBuckets: BucketId[], inputText: string): DecompositionConflictRisk {
  if (bucket === 'verification') return 'low';
  const sharedIntent = /\bshared|refactor|foundation|core|cross[- ]module|orchestrat/i.test(inputText);
  const hasApiAndBackend = allImplementationBuckets.includes('api') && allImplementationBuckets.includes('backend');
  if ((sharedIntent && allImplementationBuckets.length > 1) || (hasApiAndBackend && (bucket === 'api' || bucket === 'backend'))) return 'high';
  if (files.length >= 4 || allImplementationBuckets.length >= 3) return 'medium';
  return 'low';
}

function makeNode(
  bucket: BucketId,
  files: Candidate[],
  allImplementationBuckets: BucketId[],
  input: BuildWorkDecompositionInput,
): WorkDecompositionNode {
  const inputText = [input.title, input.description, input.reasoning, input.repoContext].filter(Boolean).join(' ');
  const hasAnyEvidence = files.length > 0;
  const atlasStale = input.atlasEvidence?.stale === true;
  const uncertaintyValues = files.map((file) => candidateUncertainty(file, hasAnyEvidence, atlasStale));
  const uncertainty: DecompositionUncertainty = uncertaintyValues.includes('high')
    ? 'high'
    : uncertaintyValues.includes('medium')
      ? 'medium'
      : 'low';
  const targetFiles = uniqueSorted(files.map((file) => file.path));
  const targetSymbols = uniqueSorted(files.flatMap((file) => file.symbols));
  const evidence = files.flatMap((file) => file.reasons)
    .sort((left, right) => (left.path || '').localeCompare(right.path || '') || left.reason.localeCompare(right.reason));
  const verificationOwnership = bucket === 'verification'
    ? [input.verification?.trim() || 'Run focused regression coverage for the decomposed change.']
    : [`Provide focused verification evidence for ${bucketTitle(bucket).toLowerCase()}.`];

  return {
    id: bucket,
    title: bucketTitle(bucket),
    kind: bucket,
    targetFiles,
    targetSymbols,
    evidence,
    dependsOn: [],
    uncertainty,
    conflictRisk: nodeConflictRisk(bucket, files, allImplementationBuckets, inputText),
    verificationOwnership,
    blockers: [],
    runnable: false,
  };
}

function pushEdge(edges: WorkDecompositionEdge[], from: string, to: string, kind: DecompositionEdgeKind, reason: string) {
  if (from === to || edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind)) return;
  edges.push({ from, to, kind, reason });
}

function graphDependencies(nodes: WorkDecompositionNode[], edges: WorkDecompositionEdge[], input: BuildWorkDecompositionInput) {
  const ids = new Set(nodes.map((node) => node.id));
  const implementationIds = nodes.filter((node) => node.kind !== 'verification' && node.kind !== 'discovery').map((node) => node.id);

  if (ids.has('contract')) {
    for (const id of implementationIds) {
      if (id !== 'contract' && id !== 'migration') {
        pushEdge(edges, 'contract', id, 'prerequisite', 'Shared contract must stabilize before dependent implementation.');
      }
    }
  }
  if (ids.has('migration')) {
    for (const id of implementationIds) {
      if (id !== 'migration' && id !== 'contract') {
        pushEdge(edges, 'migration', id, 'prerequisite', 'Persistence/schema change must land before consumers depend on it.');
      }
    }
  }

  const risky = nodes.filter((node) => node.kind !== 'verification' && node.conflictRisk === 'high');
  const orderedRisky = [...risky].sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 1; index < orderedRisky.length; index += 1) {
    const previous = orderedRisky[index - 1];
    const current = orderedRisky[index];
    const alreadyOrdered = edges.some((edge) => edge.from === previous.id && edge.to === current.id)
      || edges.some((edge) => edge.from === current.id && edge.to === previous.id);
    if (!alreadyOrdered) {
      pushEdge(edges, previous.id, current.id, 'conflict-serialization', 'High-conflict shared scope should execute sequentially.');
    }
  }

  if (ids.has('verification')) {
    for (const id of implementationIds) {
      pushEdge(edges, id, 'verification', 'verification', 'Verification owns evidence after this implementation slice completes.');
    }
  }

  for (const node of nodes) {
    node.dependsOn = uniqueSorted(edges.filter((edge) => edge.to === node.id).map((edge) => edge.from));
  }
}

function makeDiscoveryNode(input: BuildWorkDecompositionInput): WorkDecompositionNode {
  return {
    id: 'discovery',
    title: 'Resolve evidence-backed implementation targets',
    kind: 'discovery',
    targetFiles: [],
    targetSymbols: [],
    evidence: [],
    dependsOn: [],
    uncertainty: 'high',
    conflictRisk: 'medium',
    verificationOwnership: ['Confirm target files/symbols/tests before implementation starts.'],
    blockers: ['Repository evidence did not support a concrete implementation target.'],
    runnable: false,
  };
}

function deriveParallelGroups(nodes: WorkDecompositionNode[], edges: WorkDecompositionEdge[]) {
  const candidates = nodes.filter((node) => node.runnable && node.conflictRisk !== 'high').map((node) => node.id).sort();
  if (candidates.length < 2) return candidates.map((id) => [id]);
  const conflicts = new Set(edges.filter((edge) => edge.kind === 'conflict-serialization').flatMap((edge) => [edge.from, edge.to]));
  const parallel = candidates.filter((id) => !conflicts.has(id));
  return parallel.length > 1 ? [parallel] : candidates.map((id) => [id]);
}

export function buildWorkDecomposition(input: BuildWorkDecompositionInput): WorkDecompositionResult {
  const candidates = candidateMap(input);
  const implementationCandidates = candidates.filter((candidate) => !candidate.test);
  const verificationCandidates = candidates.filter((candidate) => candidate.test);
  const buckets = new Map<BucketId, Candidate[]>();
  for (const candidate of implementationCandidates) {
    const list = buckets.get(candidate.bucket) || [];
    list.push(candidate);
    buckets.set(candidate.bucket, list);
  }

  const implementationBuckets = Array.from(buckets.keys()).filter((bucket) => bucket !== 'verification').sort();
  let nodes = implementationBuckets.map((bucket) => makeNode(bucket, buckets.get(bucket) || [], implementationBuckets, input));

  if (nodes.length === 0) {
    nodes = [makeDiscoveryNode(input)];
  } else {
    nodes.push(makeNode('verification', verificationCandidates, implementationBuckets, input));
  }

  const edges: WorkDecompositionEdge[] = [];
  graphDependencies(nodes, edges, input);
  edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind));

  const nodeIds = new Set(nodes.map((node) => node.id));
  const warnings = (input.atlasEvidence?.warnings || []).map((warning) => typeof warning === 'string' ? warning : warning.message || warning.code || 'Atlas warning');
  if (input.atlasEvidence?.stale) warnings.push('Project Atlas evidence is stale; repo-index or explicit target evidence is preferred.');

  for (const node of nodes) {
    if (node.kind === 'discovery') continue;
    if (node.targetFiles.length === 0 && node.kind !== 'verification') {
      node.blockers.push('No repository evidence supports this implementation slice.');
    }
    if (node.uncertainty === 'high' && node.kind !== 'verification') {
      node.blockers.push('Target evidence is too uncertain to execute safely.');
    }
    const unresolvedDependencies = node.dependsOn.filter((dependency) => !nodeIds.has(dependency));
    if (unresolvedDependencies.length > 0) {
      node.blockers.push(`Missing dependency nodes: ${unresolvedDependencies.join(', ')}`);
    }
    node.blockers = uniqueSorted(node.blockers);
  }

  const pendingDependencies = (node: WorkDecompositionNode) => node.dependsOn.filter((dependency) => {
    const parent = nodes.find((candidate) => candidate.id === dependency);
    return Boolean(parent && parent.kind !== 'discovery');
  });
  for (const node of nodes) {
    node.runnable = node.blockers.length === 0 && pendingDependencies(node).length === 0 && node.kind !== 'verification';
  }

  const runnableNow = nodes.filter((node) => node.runnable).map((node) => node.id).sort();
  const blocked = nodes
    .flatMap((node) => {
      const reasons = [...node.blockers];
      if (node.kind === 'verification' && node.dependsOn.length > 0) reasons.push(`Wait for ${node.dependsOn.join(', ')} before final verification.`);
      if (node.kind !== 'verification' && node.dependsOn.length > 0) reasons.push(`Blocked by prerequisite: ${node.dependsOn.join(', ')}.`);
      return reasons.map((reason) => ({ nodeId: node.id, reason }));
    })
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.reason.localeCompare(right.reason));

  return {
    schemaVersion: 1,
    repoRevision: input.repoEvidence?.repoRevision,
    nodes,
    edges,
    runnableNow,
    blocked,
    parallelGroups: deriveParallelGroups(nodes, edges),
    warnings: uniqueSorted(warnings),
  };
}
