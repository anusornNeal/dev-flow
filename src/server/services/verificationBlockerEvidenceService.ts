import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { VerificationCoverageIdentity } from './verificationBatchService.js';

const MAX_BLOCKER_EVIDENCE = 64;
const MAX_OUTPUT_BYTES = 24_000;
const SOURCE_EXTENSIONS = 'kt|kts|java|ts|tsx|js|jsx|mjs|cjs|gradle|gradle.kts|xml|json|yaml|yml';

type BlockerSourceIdentity = Readonly<{
  path: string;
  fingerprint: string;
}>;

export type VerificationBlockerEvidence = Readonly<{
  id: string;
  command: string;
  semanticKey: string;
  commandConfigFingerprint: string;
  dependencyFingerprint: string;
  environmentFingerprint: string;
  platform?: string;
  arch?: string;
  runtime?: string;
  phase: string;
  failureSignature: string;
  blockerPaths: readonly string[];
  blockerSymbols: readonly string[];
  blockerSources: readonly BlockerSourceIdentity[];
  recordedTaskOwnedPaths: readonly string[];
  createdAt: string;
}>;

export type VerificationBlockerReuse = Readonly<{
  evidence: VerificationBlockerEvidence;
  reused: true;
  reason: 'known-unrelated-blocker';
}>;

const evidenceById = new Map<string, VerificationBlockerEvidence>();

function normalizeRepoPath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

function pathOverlaps(leftValue: string, rightValue: string) {
  const left = normalizeRepoPath(leftValue).toLowerCase();
  const right = normalizeRepoPath(rightValue).toLowerCase();
  return Boolean(left && right && (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
}

function sourceFingerprint(repoRoot: string, repoPath: string) {
  const absolute = path.resolve(repoRoot, repoPath);
  const relative = normalizeRepoPath(path.relative(repoRoot, absolute));
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(absolute);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

function toRepoPath(repoRoot: string, rawValue: string) {
  let value = rawValue.trim().replace(/^file:\/\/\//i, '');
  try { value = decodeURIComponent(value); } catch { /* keep raw */ }
  value = value.replace(/[),;]+$/, '');
  const absolute = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
    ? path.resolve(value)
    : path.resolve(repoRoot, value);
  const relative = normalizeRepoPath(path.relative(repoRoot, absolute));
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative;
}

function extractBlockerPaths(repoRoot: string, output: string) {
  const paths = new Set<string>();
  const absolutePattern = new RegExp(`(?:file:\\/\\/\\/)?([A-Za-z]:[\\\\/][^\\n\\r]+?\\.(?:${SOURCE_EXTENSIONS}))(?=[:\\s)\\],]|$)`, 'gi');
  const relativePattern = new RegExp(`(?:^|[\\s(\\[\"'])([A-Za-z0-9_@.+-]+(?:[\\\\/][A-Za-z0-9_@.+-]+)+\\.(?:${SOURCE_EXTENSIONS}))(?=[:\\s)\\],\"']|$)`, 'gim');
  for (const pattern of [absolutePattern, relativePattern]) {
    for (const match of output.matchAll(pattern)) {
      const repoPath = toRepoPath(repoRoot, String(match[1] || ''));
      if (repoPath) paths.add(repoPath);
    }
  }
  return [...paths].sort();
}

function extractBlockerSymbols(output: string) {
  const symbols = new Set<string>();
  const pattern = /\b([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)\b/g;
  for (const match of output.matchAll(pattern)) {
    const symbol = String(match[1] || '');
    if (symbol.length <= 160) symbols.add(symbol);
    if (symbols.size >= 16) break;
  }
  return [...symbols].sort();
}

function failurePhase(output: string) {
  const lower = output.toLowerCase();
  if (/(test[^\n]{0,40}compil|compil[^\n]{0,40}test|testcompile|compiletest)/.test(lower)) return 'test-compile';
  if (/(compilation failed|compilekotlin|compilejava|compiler error|syntax error|unresolved reference)/.test(lower)) return 'compile';
  if (/(typecheck|type error|ts\d{3,5})/.test(lower)) return 'typecheck';
  if (/(assertion|expected .* actual|tests? failed|test failure)/.test(lower)) return 'test';
  if (/(lint|eslint|detekt)/.test(lower)) return 'lint';
  return 'command';
}

export function normalizeVerificationFailureSignature(outputValue: string, repoRoot = '') {
  const root = normalizeRepoPath(repoRoot).toLowerCase();
  const normalized = String(outputValue || '')
    .slice(0, MAX_OUTPUT_BYTES)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /error|fail|exception|unresolved|cannot|could not|expected|actual|compile/i.test(line))
    .slice(0, 16)
    .join('\n')
    .toLowerCase()
    .replace(/file:\/\/\//g, '')
    .replace(root ? new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/, '<repo>')
    .replace(/[a-f0-9]{12,}/g, '<hex>')
    .replace(/:\d+(?::\d+)?/g, ':<loc>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|m|min|minutes)\b/g, '<duration>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function completeCoverage(coverage: VerificationCoverageIdentity | null | undefined) {
  return Boolean(
    coverage?.command
      && coverage.semanticKey
      && coverage.commandConfigFingerprint
      && coverage.dependencyFingerprint
      && coverage.environmentFingerprint,
  );
}

function sameCoverage(left: VerificationBlockerEvidence, right: VerificationCoverageIdentity) {
  return left.command === right.command
    && left.semanticKey === right.semanticKey
    && left.commandConfigFingerprint === right.commandConfigFingerprint
    && left.dependencyFingerprint === right.dependencyFingerprint
    && left.environmentFingerprint === right.environmentFingerprint
    && (left.platform || '') === (right.platform || '')
    && (left.arch || '') === (right.arch || '')
    && (left.runtime || '') === (right.runtime || '');
}

function currentSourcesMatch(repoRoot: string, evidence: VerificationBlockerEvidence) {
  return evidence.blockerSources.length > 0 && evidence.blockerSources.every((source) => sourceFingerprint(repoRoot, source.path) === source.fingerprint);
}

function prune() {
  while (evidenceById.size > MAX_BLOCKER_EVIDENCE) {
    const oldest = evidenceById.keys().next().value;
    if (!oldest) break;
    evidenceById.delete(oldest);
  }
}

export function clearVerificationBlockerEvidence() {
  const count = evidenceById.size;
  evidenceById.clear();
  return count;
}

export function getVerificationBlockerEvidenceStats() {
  return { entries: evidenceById.size, maxEntries: MAX_BLOCKER_EVIDENCE, retention: 'process-local-bounded' as const };
}

export function classifyAndRememberVerificationBlocker(input: {
  repoRoot: string;
  coverage: VerificationCoverageIdentity | null | undefined;
  taskOwnedPaths: readonly string[];
  stdout?: string;
  stderr?: string;
}) {
  if (!completeCoverage(input.coverage)) return null;
  const coverage = input.coverage!;
  const output = `${input.stderr || ''}\n${input.stdout || ''}`.slice(0, MAX_OUTPUT_BYTES);
  const failureSignature = normalizeVerificationFailureSignature(output, input.repoRoot);
  if (!failureSignature) return null;
  const blockerPaths = extractBlockerPaths(input.repoRoot, output);
  if (blockerPaths.length === 0) return null;
  const ownedPaths = Array.from(new Set(input.taskOwnedPaths.map(String).map(normalizeRepoPath).filter(Boolean))).sort();
  if (blockerPaths.some((blockerPath) => ownedPaths.some((ownedPath) => pathOverlaps(blockerPath, ownedPath)))) return null;
  const blockerSources = blockerPaths.map((blockerPath) => ({ path: blockerPath, fingerprint: sourceFingerprint(input.repoRoot, blockerPath) }))
    .filter((entry): entry is { path: string; fingerprint: string } => Boolean(entry.fingerprint));
  if (blockerSources.length !== blockerPaths.length) return null;
  const phase = failurePhase(output);
  const blockerSymbols = extractBlockerSymbols(output);
  const comparable = {
    command: coverage.command,
    semanticKey: coverage.semanticKey,
    commandConfigFingerprint: coverage.commandConfigFingerprint!,
    dependencyFingerprint: coverage.dependencyFingerprint!,
    environmentFingerprint: coverage.environmentFingerprint!,
    platform: coverage.platform || '',
    arch: coverage.arch || '',
    runtime: coverage.runtime || '',
    phase,
    failureSignature,
    blockerSources,
  };
  const id = `verification-blocker-${crypto.createHash('sha256').update(JSON.stringify(comparable)).digest('hex').slice(0, 24)}`;
  const evidence: VerificationBlockerEvidence = Object.freeze({
    id,
    command: coverage.command,
    semanticKey: coverage.semanticKey,
    commandConfigFingerprint: coverage.commandConfigFingerprint!,
    dependencyFingerprint: coverage.dependencyFingerprint!,
    environmentFingerprint: coverage.environmentFingerprint!,
    ...(coverage.platform ? { platform: coverage.platform } : {}),
    ...(coverage.arch ? { arch: coverage.arch } : {}),
    ...(coverage.runtime ? { runtime: coverage.runtime } : {}),
    phase,
    failureSignature,
    blockerPaths: Object.freeze([...blockerPaths]),
    blockerSymbols: Object.freeze([...blockerSymbols]),
    blockerSources: Object.freeze(blockerSources.map((entry) => Object.freeze({ ...entry }))),
    recordedTaskOwnedPaths: Object.freeze([...ownedPaths]),
    createdAt: new Date().toISOString(),
  });
  evidenceById.delete(id);
  evidenceById.set(id, evidence);
  prune();
  return evidence;
}

export function findReusableVerificationBlocker(input: {
  repoRoot: string;
  coverage: VerificationCoverageIdentity | null | undefined;
  taskOwnedPaths: readonly string[];
  failureSignature?: string | null;
}): VerificationBlockerReuse | null {
  if (!completeCoverage(input.coverage)) return null;
  const coverage = input.coverage!;
  const ownedPaths = input.taskOwnedPaths.map(String).map(normalizeRepoPath).filter(Boolean);
  const entries = [...evidenceById.values()].reverse();
  for (const evidence of entries) {
    if (!sameCoverage(evidence, coverage)) continue;
    if (input.failureSignature && input.failureSignature !== evidence.failureSignature) continue;
    if (evidence.blockerPaths.some((blockerPath) => ownedPaths.some((ownedPath) => pathOverlaps(blockerPath, ownedPath)))) continue;
    if (!currentSourcesMatch(input.repoRoot, evidence)) continue;
    return Object.freeze({ evidence, reused: true, reason: 'known-unrelated-blocker' as const });
  }
  return null;
}
