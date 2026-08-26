import { validateTaskQuality, type TaskQualityResult } from './taskQualityService.js';
import type {
  WorkDecompositionEdge,
  WorkDecompositionNode,
  WorkDecompositionResult,
} from './workDecompositionService.js';

export interface BuildDecompositionCardPlanInput {
  projectId: string;
  parentTitle: string;
  decomposition: WorkDecompositionResult;
  createRequested?: boolean;
}

export interface DecompositionCardChecklistItem {
  id: string;
  text: string;
  completed: boolean;
}

export interface DecompositionCardDraft {
  decompositionNodeId?: string;
  title: string;
  description: string;
  status: 'backlog';
  priority: 'medium';
  category: 'frontend' | 'backend' | 'general';
  tags: string[];
  targetFiles: string[];
  prerequisiteTaskIds?: string[];
  checklist: DecompositionCardChecklistItem[];
  reasoning: string;
  acceptanceCriteria: string;
  verification: string;
  repoContext: string;
}

export interface DecompositionCardOverlap {
  path: string;
  nodeIds: string[];
  explained: boolean;
  explanation?: string;
}
export interface DecompositionCardUnnecessarySplit {
  kind: string;
  scope: string;
  nodeIds: string[];
  reason: string;
}

export interface DecompositionCardQualityEntry {
  role: 'parent' | 'child';
  nodeId?: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface DecompositionCardEvaluation {
  ok: boolean;
  score: number;
  errors: string[];
  warnings: string[];
  overlaps: DecompositionCardOverlap[];
  unnecessarySplits: DecompositionCardUnnecessarySplit[];
  missingDependencies: string[];
  quality: DecompositionCardQualityEntry[];
}

export interface DecompositionCardPlan {
  mode: 'inspect' | 'create-requested';
  parent: DecompositionCardDraft;
  children: DecompositionCardDraft[];
  evaluation: DecompositionCardEvaluation;
  creationPayload?: {
    projectId: string;
    parent: Omit<DecompositionCardDraft, 'decompositionNodeId'>;
    children: Array<Omit<DecompositionCardDraft, 'decompositionNodeId'>>;
  };
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.map((value) => cleanText(value)).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function categoryForNode(node: WorkDecompositionNode): DecompositionCardDraft['category'] {
  if (node.kind === 'frontend') return 'frontend';
  if (['contract', 'migration', 'api', 'backend'].includes(node.kind)) return 'backend';
  return 'general';
}

function verificationNode(decomposition: WorkDecompositionResult) {
  return decomposition.nodes.find((node) => node.kind === 'verification');
}

function integrationVerification(decomposition: WorkDecompositionResult) {
  const verification = verificationNode(decomposition);
  const ownership = uniqueSorted([
    ...(verification?.verificationOwnership || []),
    ...decomposition.nodes
      .filter((node) => node.kind !== 'verification')
      .flatMap((node) => node.verificationOwnership || []),
  ]);
  return ownership.length > 0
    ? ownership.join(' ')
    : 'Run focused regression coverage for the decomposed change and verify integrated behavior.';
}

function parentDraft(input: BuildDecompositionCardPlanInput): DecompositionCardDraft {
  const implementationNodes = input.decomposition.nodes.filter((node) => node.kind !== 'verification');
  const targetFiles = uniqueSorted(implementationNodes.flatMap((node) => node.targetFiles || []));
  const blockedCount = implementationNodes.filter((node) => node.blockers?.length || node.kind === 'discovery').length;
  const runnableCount = input.decomposition.runnableNow.length;
  const description = [
    `Integration parent for ${implementationNodes.length} decomposition slice${implementationNodes.length === 1 ? '' : 's'}.`,
    `Runnable now: ${runnableCount}. Blocked/prep: ${blockedCount}.`,
    'Children own focused implementation; this parent owns final integration and verification.',
  ].join(' ');
  const checklist: DecompositionCardChecklistItem[] = implementationNodes.map((node) => ({
    id: `integrate-${node.id}`,
    text: `Integrate child slice ${node.id}: ${node.title}.`,
    completed: false,
  }));
  checklist.push({
    id: 'final-verification',
    text: 'Run the parent integration verification after all executable children are complete.',
    completed: false,
  });

  return {
    title: cleanText(input.parentTitle) || 'Decomposed implementation plan',
    description,
    status: 'backlog',
    priority: 'medium',
    category: 'general',
    tags: ['decomposition-parent'],
    targetFiles,
    checklist,
    reasoning: 'This parent preserves integration ownership while focused children own implementation slices from an evidence-backed decomposition DAG.',
    acceptanceCriteria: 'All child dependencies are respected, blocked decisions remain explicit, sibling scope does not overlap without explanation, and integrated behavior satisfies the decomposition verification ownership.',
    verification: integrationVerification(input.decomposition),
    repoContext: [
      'Decomposition integration plan:',
      `- Repository revision: ${input.decomposition.repoRevision || 'unknown'}`,
      `- Child nodes: ${implementationNodes.map((node) => node.id).join(', ') || 'none'}`,
      `- Runnable now: ${input.decomposition.runnableNow.join(', ') || 'none'}`,
      `- Blocked entries: ${input.decomposition.blocked.map((entry) => `${entry.nodeId}: ${entry.reason}`).join(' | ') || 'none'}`,
      '- Parent owns final integration and verification; children must stay within their mapped target scope.',
    ].join('\n'),
  };
}

function edgeBetween(edges: WorkDecompositionEdge[], left: string, right: string) {
  return edges.find((edge) =>
    ((edge.from === left && edge.to === right) || (edge.from === right && edge.to === left))
    && (edge.kind === 'prerequisite' || edge.kind === 'conflict-serialization'));
}

function prerequisitesFor(node: WorkDecompositionNode, decomposition: WorkDecompositionResult) {
  return uniqueSorted([
    ...(node.dependsOn || []),
    ...decomposition.edges
      .filter((edge) => edge.to === node.id && edge.kind !== 'verification')
      .map((edge) => edge.from),
  ]);
}

function implementationMap(node: WorkDecompositionNode, prerequisites: string[]) {
  const files = node.targetFiles.length > 0 ? node.targetFiles.join(', ') : 'No implementation target yet (blocked/prep node)';
  const symbols = node.targetSymbols.length > 0 ? node.targetSymbols.join(', ') : 'Resolve exact symbol during the bounded child scope';
  return [
    'Implementation map:',
    `- File: ${files}`,
    `  Class/function: ${symbols}`,
    `  Current behavior: ${node.evidence.length > 0 ? node.evidence.map((item) => item.reason).slice(0, 2).join(' ') : 'No implementation evidence is available yet.'}`,
    `  Expected change: ${node.kind === 'discovery' ? 'Resolve the blocked decision and collect repository evidence before implementation.' : node.title}`,
    `Prerequisites: ${prerequisites.join(', ') || 'none'}`,
  ].join('\n');
}

function childDraft(node: WorkDecompositionNode, decomposition: WorkDecompositionResult): DecompositionCardDraft {
  const prerequisites = prerequisitesFor(node, decomposition);
  const blockedReasons = uniqueSorted([
    ...(node.blockers || []),
    ...decomposition.blocked.filter((entry) => entry.nodeId === node.id).map((entry) => entry.reason),
  ]);
  const blocked = node.kind === 'discovery' || blockedReasons.length > 0;
  const checklist: DecompositionCardChecklistItem[] = [];
  for (const prerequisite of prerequisites) {
    checklist.push({
      id: `prerequisite-${prerequisite}`,
      text: `Confirm prerequisite ${prerequisite} is complete before starting this slice.`,
      completed: false,
    });
  }
  if (blocked) {
    checklist.push({
      id: 'resolve-blocker',
      text: `Resolve blocker before implementation: ${blockedReasons.join(' ') || 'Repository evidence and product decision are required.'}`,
      completed: false,
    });
  } else {
    checklist.push({
      id: 'implement-scope',
      text: `Implement only the mapped ${node.kind} scope and preserve the declared target boundaries.`,
      completed: false,
    });
  }
  checklist.push({
    id: 'verify-scope',
    text: node.verificationOwnership.join(' ') || `Provide focused verification evidence for ${node.title}.`,
    completed: false,
  });

  const tags = ['decomposition-child', `decomposition-${node.kind}`];
  if (blocked) tags.push('decomposition-blocked');
  if (node.conflictRisk === 'high') tags.push('decomposition-high-conflict');

  return {
    decompositionNodeId: node.id,
    title: node.title,
    description: blocked
      ? `Preparation node from decomposition DAG. ${blockedReasons.join(' ') || 'Resolve missing evidence before implementation.'}`
      : `Focused ${node.kind} implementation slice generated from the approved decomposition DAG.`,
    status: 'backlog',
    priority: 'medium',
    category: categoryForNode(node),
    tags,
    targetFiles: uniqueSorted(node.targetFiles || []),
    prerequisiteTaskIds: prerequisites,
    checklist,
    reasoning: blocked
      ? `Blocked preparation work. Do not invent implementation targets. ${blockedReasons.join(' ') || 'Repository evidence is required.'}`
      : `Evidence-backed decomposition node ${node.id}; uncertainty=${node.uncertainty}; conflictRisk=${node.conflictRisk}.`,
    acceptanceCriteria: blocked
      ? 'The unresolved decision/evidence gap is resolved and concrete implementation targets are identified before implementation starts.'
      : `The ${node.kind} slice is complete within the mapped target scope, prerequisites are respected, and focused verification evidence is attached.`,
    verification: node.verificationOwnership.join(' ') || `Run focused verification for ${node.title}.`,
    repoContext: implementationMap(node, prerequisites),
  };
}

function qualityEntry(role: 'parent' | 'child', draft: DecompositionCardDraft, nodeId?: string): DecompositionCardQualityEntry {
  const quality: TaskQualityResult = validateTaskQuality(draft);
  return {
    role,
    ...(nodeId ? { nodeId } : {}),
    ok: quality.ok,
    errors: [...quality.errors],
    warnings: [...quality.warnings],
  };
}

function findMissingDependencies(decomposition: WorkDecompositionResult) {
  const nodeIds = new Set(decomposition.nodes.map((node) => node.id));
  const missing = new Set<string>();
  for (const node of decomposition.nodes) {
    for (const dependency of node.dependsOn || []) {
      if (!nodeIds.has(dependency)) missing.add(dependency);
    }
  }
  for (const edge of decomposition.edges) {
    if (!nodeIds.has(edge.from)) missing.add(edge.from);
    if (!nodeIds.has(edge.to)) missing.add(edge.to);
  }
  return uniqueSorted(Array.from(missing));
}

function findOverlaps(children: DecompositionCardDraft[], decomposition: WorkDecompositionResult) {
  const owners = new Map<string, string[]>();
  for (const child of children) {
    if (!child.decompositionNodeId) continue;
    for (const filePath of child.targetFiles) {
      const normalized = filePath.replace(/\\/g, '/');
      const list = owners.get(normalized) || [];
      list.push(child.decompositionNodeId);
      owners.set(normalized, list);
    }
  }

  const overlaps: DecompositionCardOverlap[] = [];
  for (const [filePath, rawNodeIds] of owners) {
    const nodeIds = uniqueSorted(rawNodeIds);
    if (nodeIds.length < 2) continue;
    const pairExplanations: WorkDecompositionEdge[] = [];
    let explained = true;
    for (let left = 0; left < nodeIds.length; left += 1) {
      for (let right = left + 1; right < nodeIds.length; right += 1) {
        const edge = edgeBetween(decomposition.edges, nodeIds[left], nodeIds[right]);
        if (!edge) explained = false;
        else pairExplanations.push(edge);
      }
    }
    overlaps.push({
      path: filePath,
      nodeIds,
      explained,
      ...(pairExplanations.length > 0
        ? { explanation: uniqueSorted(pairExplanations.map((edge) => `${edge.kind}: ${edge.reason}`)).join(' | ') }
        : {}),
    });
  }
  return overlaps.sort((left, right) => left.path.localeCompare(right.path));
}

function targetScope(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '.';
}

function findUnnecessarySplits(decomposition: WorkDecompositionResult) {
  const groups = new Map<string, WorkDecompositionNode[]>();
  for (const node of decomposition.nodes) {
    if (node.kind === 'verification' || node.kind === 'discovery' || node.blockers.length > 0 || node.targetFiles.length !== 1) continue;
    const prerequisites = prerequisitesFor(node, decomposition).join(',');
    const key = `${node.kind}|${targetScope(node.targetFiles[0])}|${prerequisites}`;
    const list = groups.get(key) || [];
    list.push(node);
    groups.set(key, list);
  }

  const findings: DecompositionCardUnnecessarySplit[] = [];
  for (const nodes of groups.values()) {
    if (nodes.length < 2) continue;
    const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
    const independentPairs: string[][] = [];
    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = left + 1; right < ordered.length; right += 1) {
        if (!edgeBetween(decomposition.edges, ordered[left].id, ordered[right].id)) {
          independentPairs.push([ordered[left].id, ordered[right].id]);
        }
      }
    }
    if (independentPairs.length === 0) continue;
    findings.push({
      kind: ordered[0].kind,
      scope: targetScope(ordered[0].targetFiles[0]),
      nodeIds: ordered.map((node) => node.id),
      reason: `Same-kind single-file siblings share scope and prerequisites without a dependency boundary: ${independentPairs.map((pair) => pair.join('/')).join(', ')}.`,
    });
  }
  return findings.sort((left, right) => left.scope.localeCompare(right.scope) || left.kind.localeCompare(right.kind));
}

function evaluatePlan(
  parent: DecompositionCardDraft,
  children: DecompositionCardDraft[],
  decomposition: WorkDecompositionResult,
): DecompositionCardEvaluation {
  const errors: string[] = [];
  const warnings: string[] = [...decomposition.warnings];
  const missingDependencies = findMissingDependencies(decomposition);
  if (missingDependencies.length > 0) {
    errors.push(`Decomposition contains dangling dependencies: ${missingDependencies.join(', ')}.`);
  }

  const overlaps = findOverlaps(children, decomposition);
  const unnecessarySplits = findUnnecessarySplits(decomposition);
  for (const split of unnecessarySplits) {
    warnings.push(`Potential unnecessary split in ${split.scope} (${split.kind}): ${split.nodeIds.join(', ')}.`);
  }
  const unexplained = overlaps.filter((entry) => !entry.explained);
  for (const overlap of unexplained) {
    errors.push(`Sibling target overlap is unexplained for ${overlap.path}: ${overlap.nodeIds.join(', ')}.`);
  }
  for (const overlap of overlaps.filter((entry) => entry.explained)) {
    warnings.push(`Sibling target overlap is serialized/explained for ${overlap.path}: ${overlap.nodeIds.join(', ')}.`);
  }

  const quality = [
    qualityEntry('parent', parent),
    ...children.map((child) => qualityEntry('child', child, child.decompositionNodeId)),
  ];
  for (const entry of quality) {
    for (const error of entry.errors) {
      errors.push(`${entry.role}${entry.nodeId ? ` ${entry.nodeId}` : ''} quality: ${error}`);
    }
    for (const warning of entry.warnings) {
      warnings.push(`${entry.role}${entry.nodeId ? ` ${entry.nodeId}` : ''} quality: ${warning}`);
    }
  }

  for (const child of children) {
    const node = decomposition.nodes.find((candidate) => candidate.id === child.decompositionNodeId);
    if (!node) continue;
    const blocked = node.kind === 'discovery' || node.blockers.length > 0 || decomposition.blocked.some((entry) => entry.nodeId === node.id);
    if (!blocked && child.targetFiles.length === 0) {
      errors.push(`Executable node ${node.id} has no evidence-backed target files.`);
    }
  }

  const nodeIds = new Set(decomposition.nodes.map((node) => node.id));
  for (const runnable of decomposition.runnableNow) {
    if (!nodeIds.has(runnable)) errors.push(`Runnable node ${runnable} does not exist in the decomposition.`);
  }

  const uniqueErrors = uniqueSorted(errors);
  const uniqueWarnings = uniqueSorted(warnings);
  const penalty = Math.min(100,
    uniqueErrors.length * 25
    + unexplained.length * 15
    + missingDependencies.length * 20
    + unnecessarySplits.length * 8
    + uniqueWarnings.length * 2);

  return {
    ok: uniqueErrors.length === 0,
    score: Math.max(0, 100 - penalty),
    errors: uniqueErrors,
    warnings: uniqueWarnings,
    overlaps,
    unnecessarySplits,
    missingDependencies,
    quality,
  };
}

function stripNodeId(draft: DecompositionCardDraft): Omit<DecompositionCardDraft, 'decompositionNodeId'> & { taskSetKey?: string } {
  const { decompositionNodeId, ...task } = draft;
  return decompositionNodeId ? { ...task, taskSetKey: decompositionNodeId } : task;
}

export function buildDecompositionCardPlan(input: BuildDecompositionCardPlanInput): DecompositionCardPlan {
  if (!cleanText(input.projectId)) throw new Error('projectId is required for decomposition card planning.');
  if (!input.decomposition || !Array.isArray(input.decomposition.nodes) || !Array.isArray(input.decomposition.edges)) {
    throw new Error('A valid decomposition DAG is required for card planning.');
  }

  const parent = parentDraft(input);
  const children = input.decomposition.nodes
    .filter((node) => node.kind !== 'verification')
    .map((node) => childDraft(node, input.decomposition));
  const evaluation = evaluatePlan(parent, children, input.decomposition);
  const mode = input.createRequested === true ? 'create-requested' as const : 'inspect' as const;
  const result: DecompositionCardPlan = { mode, parent, children, evaluation };

  if (input.createRequested === true && evaluation.ok) {
    result.creationPayload = {
      projectId: cleanText(input.projectId),
      parent: stripNodeId(parent),
      children: children.map(stripNodeId),
    };
  }

  return result;
}
