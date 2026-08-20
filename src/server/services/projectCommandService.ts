import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import {
  captureSystemResourceSnapshot,
  diffSystemResourceSnapshots,
  getMachineRuntimeProfile,
  normalizeLocalPathIdentity,
  resolvePackageManagerInvocation,
  sampleProcessTreeResources,
  terminateProcessTree,
} from '../../lib/platformRuntime';
import type { AppState } from '../types';
import { createApiError } from './api';
import { resolveProjectRoot, resolveSafePath } from './localFileService';
import { getProjectCommandConfigSnapshot, loadProjectCommandPreset } from './projectCommandConfigService';
import { buildRepoAffectedInputIdentity, getRepoDependencyFingerprint, getRepoRevisionForRoot } from './repoRevisionService';
import {
  createVerificationCandidate,
  createVerificationCandidateAsync,
  isVerificationCandidateCurrent,
  releaseVerificationCandidate,
  releaseVerificationCandidateAsync,
  resolveVerificationCandidate,
  type VerificationCandidateIdentity,
} from './verificationCandidateService';
import { getCachedCommandResult, rememberCommandResult } from './commandResultCacheService';
import { readWorkspaceMetadataFile } from './workspaceMetadataCacheService';
import { getRepoCacheLineage, recordRepoCacheAccess, registerRepoCacheInvalidator } from './repoCacheInvalidationService';
import {
  predictVerificationResourceCost,
  recordVerificationResourceSample,
  type VerificationResourcePrediction,
  type VerificationResourceProfileDescriptor,
} from './verificationResourceProfileService';

const ALLOWED_COMMANDS = ['typecheck', 'test', 'lint', 'build', 'verify'] as const;
const SAFE_BENCHMARK_PACKAGE_SCRIPT = /^benchmark:[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const MAX_COMMAND_GUIDANCE = 12;
const MAX_NEAREST_COMMAND_GUIDANCE = 5;

function isSafeBenchmarkPackageScript(command: string) {
  return SAFE_BENCHMARK_PACKAGE_SCRIPT.test(command);
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function buildCommandGuidance(command: string, scripts: Record<string, string> = {}) {
  const availableCommands = Object.keys(scripts)
    .filter((name) => (ALLOWED_COMMANDS as readonly string[]).includes(name) || isSafeBenchmarkPackageScript(name))
    .sort()
    .slice(0, MAX_COMMAND_GUIDANCE);
  const candidates = Array.from(new Set([...(ALLOWED_COMMANDS as readonly string[]), ...availableCommands]));
  const nearestValidCommands = candidates
    .map((candidate) => ({ candidate, score: commonPrefixLength(command, candidate) }))
    .sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate))
    .slice(0, MAX_NEAREST_COMMAND_GUIDANCE)
    .map((entry) => entry.candidate);
  return { availableCommands, nearestValidCommands };
}
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 12_000;
const COMPACT_MAX_OUTPUT_BYTES = 2_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 100_000;
const MAX_PACKAGE_JSON_BYTES = 10 * 1024 * 1024;
const MAX_COMMAND_TARGETS = 20;
const MAX_COMMAND_TARGET_LENGTH = 500;
const packageScriptsParseCache = new Map<string, { size: number; mtimeMs: number; scripts: Record<string, string> }>();
const PROJECT_COMMAND_CACHE_DEPENDENCIES = ['repo-content', 'repo-revision', 'project-rules'] as const;
const PROCESS_RESOURCE_SAMPLE_DELAY_MS = 1_000;
const PROCESS_RESOURCE_SAMPLE_INTERVAL_MS = 1_500;
const MACHINE_RUNTIME_PROFILE = getMachineRuntimeProfile();

const INFRASTRUCTURE_RETRY_POLICIES = new Set(['none', 'resource-safe-once']);
const VERIFICATION_RECOVERY_PROFILE = 'verification-infra-safe';
const INFRASTRUCTURE_FAILURE_OUTPUT = /(OutOfMemoryError|Java heap space|heap out of memory|allocation failed[^\n]*heap|killed process|process[^\n]*killed|worker lease|verification capacity|tool runner[^\n]*crash)/i;
const RECOVERY_SHARED_RESOURCE = 'verification-recovery';
const MIB = 1024 ** 2;

export type VerificationInfrastructureRecoveryProfile = {
  kind: 'resource-safe';
  attempt: 1;
  gradleTuned: boolean;
  heapMb: number | null;
  heapFloorMb: number | null;
  heapPolicyCeilingMb: number | null;
  heapSafeExistingCeilingMb: number | null;
  existingHeapMb: number | null;
  heapSource: 'machine-policy' | 'existing-larger-safe' | null;
  maxWorkers: number | null;
  requestedTimeoutMs: number;
  timeoutMs: number;
  timeoutCapped: boolean;
  sharedResource: string;
};

export type VerificationInfrastructureRecoveryAudit = {
  policy: 'resource-safe-once';
  attempted: boolean;
  retryCount: 0 | 1;
  firstFailure?: {
    failureClass: 'infrastructure';
    status: CommandStatus;
    exitCode: number | null;
    timedOut: boolean;
    signal: NodeJS.Signals | null;
    stderr: string;
  };
  profile?: VerificationInfrastructureRecoveryProfile;
  finalStatus: CommandStatus;
};

registerRepoCacheInvalidator('verification-results', () => 0, {
  dependencies: [...PROJECT_COMMAND_CACHE_DEPENDENCIES],
});

type AllowedCommand = typeof ALLOWED_COMMANDS[number];
type CommandStatus = 'succeeded' | 'failed' | 'timed_out';
type ResolvedCommand = {
  command: string;
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  source: 'package-json' | 'repository-config';
  configPath?: string;
  script?: string;
  category?: string;
  sharedResources?: string[];
  acceptsTargets?: boolean;
  configuredExecutable?: string;
  configuredArgs?: string[];
  targets?: string[];
};

export type ProjectCommandScope = 'targeted' | 'broad' | 'full';
export type ProjectCommandCost = 'low' | 'medium' | 'high';
export type ProjectCommandAccess = 'verify' | 'write';
export type ProjectCommandVerificationClass = 'fast' | 'heavy';

export type ProjectCommandDescriptor = {
  command: string;
  semanticKey: string;
  scope: ProjectCommandScope;
  cost: ProjectCommandCost;
  access: ProjectCommandAccess;
  resourceKey: string;
  verificationClass: ProjectCommandVerificationClass;
  sharedResources: string[];
  executable: string;
  args: string[];
  cwd: string;
  source: ResolvedCommand['source'];
  configPath?: string;
};

export interface RunProjectCommandResult {
  ok: boolean;
  responseMode?: 'compact' | 'standard' | 'debug';
  processSpawns?: number;
  performance?: {
    resolutionMs: number;
    cacheLookupMs?: number;
    executionMs: number;
    processStartupMs?: number;
    resultNormalizationMs?: number;
    totalMs?: number;
  };
  status: CommandStatus;
  command: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutEmpty: boolean;
  stderrEmpty: boolean;
  outputSummary: {
    hasStdout: boolean;
    hasStderr: boolean;
    stdoutBytes: number;
    stderrBytes: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  infrastructureRecovery?: VerificationInfrastructureRecoveryAudit;
  verificationCandidate?: {
    candidateId: string;
    repoRevision: string;
    snapshotCommit: string;
    executionKey: string;
    current: boolean;
  };
  resourceProfile?: {
    profileKey: string;
    machineKey: string;
    sharedResources: string[];
    prediction: VerificationResourcePrediction;
    actual: {
      durationMs: number;
      systemCpuRatio: number;
      memoryPressureRatio: number;
      cpuRatio?: number;
      memoryBytes?: number;
      partialMemoryBytes?: number;
      processCount?: number;
      processTreeAccounting: boolean;
      processTreeMemoryAccounting: 'complete' | 'partial' | 'unknown';
      processTreeSampleAttempts: number;
      processTreeSampleCount: number;
    };
    predictionError: {
      duration?: number;
      cpu?: number;
      memory?: number;
    };
  };
  cache?: {
    hit: boolean;
    key: string;
    repoRevision: string;
    lineageToken?: string;
    cachedAt?: string;
    originalDurationMs?: number;
    evidenceId?: string;
    sourceConsumerId?: string;
    consumers?: string[];
    reusable?: boolean;
    affectedInputFingerprint?: string;
    dependencyFingerprint?: string;
    environmentFingerprint?: string;
  };
}

function truncateOutput(value: string, maxBytes: number, totalBytes?: number) {
  const capturedBytes = Buffer.byteLength(value, 'utf8');
  const bytes = totalBytes ?? capturedBytes;
  if (bytes <= maxBytes) {
    return { value, bytes, truncated: false };
  }

  return {
    value: `${Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[truncated]`,
    bytes,
    truncated: true,
  };
}

type BoundedCommandOutputCapture = {
  append: (data: Buffer | string) => void;
  snapshot: () => { value: string; bytes: number; truncated: boolean };
};

function createBoundedCommandOutputCapture(maxBytes: number): BoundedCommandOutputCapture {
  const limit = Math.max(1, maxBytes);
  const head = Buffer.allocUnsafe(limit);
  let headBytes = 0;
  let totalBytes = 0;

  return {
    append: (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      totalBytes += chunk.byteLength;
      if (headBytes >= limit) return;
      const copyBytes = Math.min(limit - headBytes, chunk.byteLength);
      chunk.copy(head, headBytes, 0, copyBytes);
      headBytes += copyBytes;
    },
    snapshot: () => ({
      value: head.subarray(0, headBytes).toString('utf8'),
      bytes: totalBytes,
      truncated: totalBytes > limit,
    }),
  };
}

export const __createBoundedCommandOutputCaptureForTests = createBoundedCommandOutputCapture;

function buildCommandResult(input: {
  command: string;
  root: string;
  cwdPath: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  stdoutRaw: string;
  stderrRaw: string;
  stdoutBytesTotal?: number;
  stderrBytesTotal?: number;
  maxOutputBytes: number;
  responseMode?: 'compact' | 'standard' | 'debug';
  resolutionMs?: number;
}): RunProjectCommandResult {
  const stdout = truncateOutput(input.stdoutRaw || '', input.maxOutputBytes, input.stdoutBytesTotal);
  const stderr = truncateOutput(input.stderrRaw || '', input.maxOutputBytes, input.stderrBytesTotal);
  const status: CommandStatus = input.timedOut
    ? 'timed_out'
    : input.exitCode === 0
      ? 'succeeded'
      : 'failed';

  return {
    ok: status === 'succeeded',
    responseMode: input.responseMode ?? 'standard',
    processSpawns: 1,
    performance: {
      resolutionMs: input.resolutionMs ?? 0,
      executionMs: input.durationMs,
    },
    status,
    command: input.command,
    cwd: path.relative(input.root, input.cwdPath) || '.',
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    timedOut: input.timedOut,
    signal: input.signal,
    stdout: stdout.value,
    stderr: stderr.value,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutEmpty: stdout.bytes === 0,
    stderrEmpty: stderr.bytes === 0,
    outputSummary: {
      hasStdout: stdout.bytes > 0,
      hasStderr: stderr.bytes > 0,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    },
  };
}

function withPerformancePhases(
  result: RunProjectCommandResult,
  metrics: {
    resolutionMs: number;
    cacheLookupMs: number;
    resultNormalizationMs: number;
    totalMs: number;
    processStartupMs?: number;
  },
): RunProjectCommandResult {
  return {
    ...result,
    performance: {
      resolutionMs: metrics.resolutionMs,
      cacheLookupMs: metrics.cacheLookupMs,
      executionMs: result.durationMs,
      ...(metrics.processStartupMs === undefined ? {} : { processStartupMs: metrics.processStartupMs }),
      resultNormalizationMs: metrics.resultNormalizationMs,
      totalMs: metrics.totalMs,
    },
  };
}

function resolveCommandLabel(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized && normalized.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(normalized)) {
    return normalized;
  }

  throw createApiError(
    400,
    'COMMAND_NOT_ALLOWED',
    `Command '${normalized || String(value || '')}' is not a valid verification preset name. Use a built-in package script, an explicit benchmark:* package script, or define it in .devflow/commands.yaml.`,
    {
      affectedId: normalized || undefined,
      details: {
        ...buildCommandGuidance(normalized),
        nextAction: 'Use a preset name matching [A-Za-z0-9][A-Za-z0-9:_-]*, or choose a configured repository preset.',
      },
    },
  );
}

function resolveSafeCommandCwd(root: string, cwdValue: unknown) {
  const cwd = typeof cwdValue === 'string' ? cwdValue.trim() : '';
  if (!cwd) return root;

  try {
    return resolveSafePath(root, cwd);
  } catch (error) {
    throw createApiError(403, 'COMMAND_CWD_DENIED', 'Requested cwd is outside the allowed project root.', {
      affectedId: cwd,
    });
  }
}

function readPackageScripts(root: string) {
  const packageJsonPath = path.join(root, 'package.json');
  const metadata = readWorkspaceMetadataFile(packageJsonPath, MAX_PACKAGE_JSON_BYTES);
  if (!metadata) {
    packageScriptsParseCache.delete(path.resolve(packageJsonPath));
    return { exists: false, scripts: {} as Record<string, string> };
  }

  const cacheKey = path.resolve(packageJsonPath);
  const cached = packageScriptsParseCache.get(cacheKey);
  if (cached && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
    return { exists: true, scripts: cached.scripts };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(metadata.content);
  } catch (error) {
    throw createApiError(400, 'INVALID_PACKAGE_JSON', 'package.json could not be parsed.', {
      details: error instanceof Error ? error.message : String(error),
    });
  }

  const scripts = parsed?.scripts && typeof parsed.scripts === 'object'
    ? parsed.scripts as Record<string, string>
    : {};
  packageScriptsParseCache.set(cacheKey, { size: metadata.size, mtimeMs: metadata.mtimeMs, scripts });
  return { exists: true, scripts };
}

function hasCommandTargetRequest(args: Record<string, any>) {
  return Object.prototype.hasOwnProperty.call(args, 'targets');
}

function resolveCommandTargets(root: string, args: Record<string, any>, acceptsTargets: boolean) {
  const supplied = hasCommandTargetRequest(args);
  if (!supplied) {
    if (acceptsTargets) {
      throw createApiError(400, 'COMMAND_TARGETS_REQUIRED', 'This verification preset requires at least one focused target path.');
    }
    return [] as string[];
  }
  if (!acceptsTargets) {
    throw createApiError(400, 'COMMAND_TARGETS_NOT_ALLOWED', 'This verification preset does not accept caller-supplied target paths.');
  }
  if (!Array.isArray(args.targets) || args.targets.length === 0) {
    throw createApiError(400, 'COMMAND_TARGETS_REQUIRED', 'Focused targets must contain at least one repository-relative file path.');
  }
  if (args.targets.length > MAX_COMMAND_TARGETS) {
    throw createApiError(400, 'COMMAND_TARGETS_TOO_MANY', `Focused targets may contain at most ${MAX_COMMAND_TARGETS} paths.`);
  }

  const resolvedRoot = path.resolve(root);
  const realRoot = fs.realpathSync(resolvedRoot);
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  const normalizedTargets = args.targets.map((entry: unknown, index: number) => {
    if (typeof entry !== 'string') {
      throw createApiError(400, 'COMMAND_TARGET_INVALID', `Focused target ${index + 1} must be a string.`);
    }
    const normalized = entry.trim().replace(/\\/g, '/');
    if (!normalized || normalized.length > MAX_COMMAND_TARGET_LENGTH || /[\r\n\0]/.test(normalized)) {
      throw createApiError(400, 'COMMAND_TARGET_INVALID', `Focused target ${index + 1} is empty, malformed, or too long.`);
    }
    if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//.test(normalized)) {
      throw createApiError(403, 'COMMAND_TARGET_OUTSIDE_ROOT', `Focused target '${normalized}' must be repository-relative.`);
    }
    const segments = normalized.split('/');
    if (segments.some((segment) => segment === '..' || segment === '.')) {
      throw createApiError(403, 'COMMAND_TARGET_OUTSIDE_ROOT', `Focused target '${normalized}' may not contain traversal segments.`);
    }

    const absolutePath = resolveSafePath(resolvedRoot, normalized);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        throw createApiError(404, 'COMMAND_TARGET_NOT_FOUND', `Focused target '${normalized}' was not found.`);
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw createApiError(403, 'COMMAND_TARGET_INVALID_TYPE', `Focused target '${normalized}' must be a regular file.`);
    }
    const realTarget = fs.realpathSync(absolutePath);
    if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) {
      throw createApiError(403, 'COMMAND_TARGET_OUTSIDE_ROOT', `Focused target '${normalized}' resolves outside the repository root.`);
    }
    return path.relative(resolvedRoot, absolutePath).replace(/\\/g, '/');
  });
  return Array.from(new Set(normalizedTargets));
}

function resolveAllowedCommand(root: string, command: string, requestArgs: Record<string, any> = {}): ResolvedCommand {
  const packageConfig = readPackageScripts(root);
  const isBuiltIn = (ALLOWED_COMMANDS as readonly string[]).includes(command);
  const isSafeBenchmark = isSafeBenchmarkPackageScript(command);
  if (isBuiltIn && packageConfig.scripts[command]) {
    resolveCommandTargets(root, requestArgs, false);
    const invocation = resolvePackageManagerInvocation('npm', ['run', '--silent', command]);
    return {
      command,
      executable: invocation.executable,
      args: invocation.args,
      source: 'package-json',
      script: packageConfig.scripts[command],
    };
  }

  const configured = loadProjectCommandPreset(root, command);
  if (configured) {
    const targets = resolveCommandTargets(root, requestArgs, configured.acceptsTargets);
    const configuredArgs = [...configured.args];
    const effectiveArgs = [...configuredArgs, ...targets];
    const invocation = configured.executable === 'npm' || configured.executable === 'npx'
      ? resolvePackageManagerInvocation(configured.executable, effectiveArgs)
      : { executable: configured.executable, args: effectiveArgs };
    return {
      command,
      executable: invocation.executable,
      args: invocation.args,
      cwd: configured.cwd,
      timeoutMs: configured.timeoutMs,
      maxOutputBytes: configured.maxOutputBytes,
      source: 'repository-config',
      configPath: configured.configPath,
      category: configured.category,
      sharedResources: configured.sharedResources,
      acceptsTargets: configured.acceptsTargets,
      configuredExecutable: configured.executable,
      configuredArgs,
      targets,
    };
  }

  if (isSafeBenchmark && packageConfig.scripts[command]) {
    resolveCommandTargets(root, requestArgs, false);
    const invocation = resolvePackageManagerInvocation('npm', ['run', '--silent', command]);
    return {
      command,
      executable: invocation.executable,
      args: invocation.args,
      source: 'package-json',
      script: packageConfig.scripts[command],
    };
  }

  const guidance = buildCommandGuidance(command, packageConfig.scripts);
  if (!isBuiltIn && !isSafeBenchmark) {
    throw createApiError(400, 'COMMAND_NOT_ALLOWED', `Command '${command}' is not an allowed direct package verification script and is not defined in .devflow/commands.yaml or .devflow/commands.json.`, {
      affectedId: command,
      details: {
        ...guidance,
        nextAction: `Use a built-in or benchmark:* package script, or define commands.${command} explicitly in .devflow/commands.yaml.`,
      },
    });
  }

  throw createApiError(400, 'COMMAND_NOT_CONFIGURED', `Verification command '${command}' is allowed by policy but is not configured. Add the exact package.json script or a repository command preset.`, {
    affectedId: command,
    details: {
      packageJsonFound: packageConfig.exists,
      ...guidance,
      nextAction: `Configure '${command}' exactly in package.json scripts or .devflow/commands.yaml.`,
    },
  });
}

function normalizeScript(value: string | undefined) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function semanticKeyForResolvedCommand(root: string, resolvedCommand: ResolvedCommand, cwdPath: string) {
  const identity = resolvedCommand.source === 'package-json'
    ? {
        source: resolvedCommand.source,
        script: normalizeScript(resolvedCommand.script),
        cwd: path.relative(root, cwdPath) || '.',
      }
    : {
        source: resolvedCommand.source,
        executable: resolvedCommand.configuredExecutable ?? resolvedCommand.executable,
        args: resolvedCommand.configuredArgs ?? resolvedCommand.args,
        targets: resolvedCommand.targets ?? [],
        cwd: path.relative(root, cwdPath) || '.',
        configPath: resolvedCommand.configPath,
        sharedResources: resolvedCommand.sharedResources,
      };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function scopeForResolvedCommand(root: string, command: string, resolvedCommand: ResolvedCommand): ProjectCommandScope {
  if (command === 'verify') return 'full';
  if (resolvedCommand.source === 'package-json') {
    const scripts = readPackageScripts(root).scripts;
    const currentScript = normalizeScript(resolvedCommand.script || scripts[command]);
    const verifyScript = normalizeScript(scripts.verify);
    if (verifyScript && currentScript === verifyScript) return 'full';
    return 'broad';
  }
  return resolvedCommand.category === 'test' ? 'targeted' : 'broad';
}

function accessForResolvedCommand(resolvedCommand: ResolvedCommand): ProjectCommandAccess {
  if (resolvedCommand.source === 'package-json') {
    return resolvedCommand.command === 'build' ? 'write' : 'verify';
  }
  return resolvedCommand.category === 'test' ? 'verify' : 'write';
}

function verificationClassFor(scope: ProjectCommandScope, cost: ProjectCommandCost): ProjectCommandVerificationClass {
  return scope === 'full' || cost === 'high' ? 'heavy' : 'fast';
}

function sharedResourcesFor(resourceKey: string, configured: string[] | undefined) {
  const resources = Array.from(new Set((configured || []).map((resource) => String(resource || '').trim()).filter(Boolean)));
  return resources.length > 0 ? resources : [resourceKey];
}

function buildProjectCommandDescriptor(
  root: string,
  command: string,
  resolvedCommand: ResolvedCommand,
  cwdPath: string,
): ProjectCommandDescriptor {
  const semanticKey = semanticKeyForResolvedCommand(root, resolvedCommand, cwdPath);
  const scope = scopeForResolvedCommand(root, command, resolvedCommand);
  const normalizedScript = normalizeScript(resolvedCommand.script);
  const cost: ProjectCommandCost = scope === 'full' ? 'high' : scope === 'targeted' ? 'low' : command === 'build' ? 'high' : 'medium';
  const access = accessForResolvedCommand(resolvedCommand);
  const resourceKey = scope === 'full'
    ? 'repo'
    : normalizedScript.includes('tsc')
      ? 'typescript'
      : scope === 'targeted'
        ? `command:${semanticKey.slice(0, 16)}`
        : 'repo';
  const verificationClass = verificationClassFor(scope, cost);
  const sharedResources = sharedResourcesFor(resourceKey, resolvedCommand.sharedResources);
  return {
    command,
    semanticKey,
    scope,
    cost,
    access,
    resourceKey,
    verificationClass,
    sharedResources,
    executable: resolvedCommand.executable,
    args: [...resolvedCommand.args],
    cwd: path.relative(root, cwdPath) || '.',
    source: resolvedCommand.source,
    ...(resolvedCommand.configPath ? { configPath: resolvedCommand.configPath } : {}),
  };
}

export function describeProjectCommand(state: AppState, args: Record<string, any>): ProjectCommandDescriptor {
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(root, command, args);
  const cwdPath = resolveSafeCommandCwd(root, args.cwd ?? resolvedCommand.cwd);
  return buildProjectCommandDescriptor(root, command, resolvedCommand, cwdPath);
}

function resourceProfileDescriptorFor(
  root: string,
  commandDescriptor: ProjectCommandDescriptor,
  args: Record<string, any>,
): VerificationResourceProfileDescriptor {
  const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : '';
  const repositoryKey = projectId
    ? `project:${projectId}`
    : `repo:${crypto.createHash('sha256').update(normalizeLocalPathIdentity(root)).digest('hex').slice(0, 24)}`;
  return {
    repositoryKey,
    semanticKey: commandDescriptor.semanticKey,
    machineKey: MACHINE_RUNTIME_PROFILE.key,
    cost: commandDescriptor.cost,
    verificationClass: commandDescriptor.verificationClass,
    sharedResources: [...commandDescriptor.sharedResources],
  };
}

export function describeProjectCommandResourceProfile(state: AppState, args: Record<string, any>) {
  const root = resolveProjectRoot(state, args);
  const commandDescriptor = describeProjectCommand(state, args);
  const resourceDescriptor = resourceProfileDescriptorFor(root, commandDescriptor, args);
  return {
    descriptor: commandDescriptor,
    resourceDescriptor,
    prediction: predictVerificationResourceCost(resourceDescriptor),
  };
}

function relativePredictionError(predicted: number | undefined, actual: number | undefined) {
  if (predicted === undefined || actual === undefined || !Number.isFinite(predicted) || !Number.isFinite(actual) || predicted <= 0) return undefined;
  return Math.abs(actual - predicted) / predicted;
}

type ProcessResourceAggregate = {
  attempts: number;
  samples: number;
  completeSamples: number;
  partialSamples: number;
  maxCpuRatio?: number;
  maxRssBytes?: number;
  maxPartialRssBytes?: number;
  maxProcessCount?: number;
};

function finalizeResourceProfile(
  descriptor: VerificationResourceProfileDescriptor,
  prediction: VerificationResourcePrediction,
  systemStart: ReturnType<typeof captureSystemResourceSnapshot>,
  durationMs: number,
  status: CommandStatus,
  processAggregate: ProcessResourceAggregate = { attempts: 0, samples: 0, completeSamples: 0, partialSamples: 0 },
) {
  const systemDelta = diffSystemResourceSnapshots(systemStart, captureSystemResourceSnapshot());
  const actualCpuRatio = processAggregate.maxCpuRatio ?? systemDelta.cpuUtilization;
  const memoryAccounting = processAggregate.completeSamples > 0
    ? 'complete' as const
    : processAggregate.partialSamples > 0
      ? 'partial' as const
      : 'unknown' as const;
  const actual = {
    durationMs,
    systemCpuRatio: systemDelta.cpuUtilization,
    memoryPressureRatio: systemDelta.peakMemoryPressure,
    ...(actualCpuRatio !== undefined ? { cpuRatio: actualCpuRatio } : {}),
    ...(processAggregate.maxRssBytes !== undefined ? { memoryBytes: processAggregate.maxRssBytes } : {}),
    ...(processAggregate.maxPartialRssBytes !== undefined ? { partialMemoryBytes: processAggregate.maxPartialRssBytes } : {}),
    ...(processAggregate.maxProcessCount !== undefined ? { processCount: processAggregate.maxProcessCount } : {}),
    processTreeAccounting: processAggregate.completeSamples > 0,
    processTreeMemoryAccounting: memoryAccounting,
    processTreeSampleAttempts: processAggregate.attempts,
    processTreeSampleCount: processAggregate.samples,
  };
  recordVerificationResourceSample(descriptor, {
    status,
    durationMs,
    cpuRatio: actual.cpuRatio,
    memoryBytes: actual.memoryBytes,
    processCount: actual.processCount,
    systemCpuRatio: actual.systemCpuRatio,
    memoryPressureRatio: actual.memoryPressureRatio,
    treeAccounting: actual.processTreeAccounting,
    predicted: prediction,
  });
  return {
    profileKey: prediction.profileKey,
    machineKey: descriptor.machineKey,
    sharedResources: [...descriptor.sharedResources],
    prediction,
    actual,
    predictionError: {
      duration: relativePredictionError(prediction.expected.durationMs, durationMs),
      cpu: relativePredictionError(prediction.expected.cpuRatio, actualCpuRatio),
      memory: relativePredictionError(prediction.expected.memoryBytes, processAggregate.maxRssBytes),
    },
  };
}

function resolveResponseMode(value: unknown): 'compact' | 'standard' | 'debug' {
  return value === 'compact' || value === 'debug' ? value : 'standard';
}

function resolveOutputBudget(args: Record<string, any>, resolvedCommand: ResolvedCommand) {
  const responseMode = resolveResponseMode(args.responseMode);
  const requested = Number.isFinite(Number(args.maxOutputBytes))
    ? Math.max(1, Math.min(MAX_OUTPUT_BYTES, Number(args.maxOutputBytes)))
    : resolvedCommand.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    responseMode,
    maxOutputBytes: responseMode === 'compact' ? Math.min(COMPACT_MAX_OUTPUT_BYTES, requested) : requested,
  };
}

type CommandExecutionOptions = {
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  recoveryProfile: VerificationInfrastructureRecoveryProfile | null;
};

function resolveInfrastructureRetryPolicy(args: Record<string, any>): 'none' | 'resource-safe-once' {
  const raw = args.infrastructureRetryPolicy == null ? 'resource-safe-once' : String(args.infrastructureRetryPolicy).trim();
  if (!INFRASTRUCTURE_RETRY_POLICIES.has(raw)) {
    throw createApiError(400, 'VERIFICATION_INFRA_RETRY_POLICY_INVALID', `Unsupported infrastructureRetryPolicy '${raw}'.`, {
      details: { allowed: [...INFRASTRUCTURE_RETRY_POLICIES] },
    });
  }
  return raw as 'none' | 'resource-safe-once';
}

function isGradleLikeCommand(resolvedCommand: ResolvedCommand) {
  const material = [
    resolvedCommand.configuredExecutable ?? resolvedCommand.executable,
    ...(resolvedCommand.configuredArgs ?? resolvedCommand.args),
    resolvedCommand.script || '',
  ].join(' ');
  return /(^|[\\/\s])gradle(?:w)?(?:\.bat)?(?:\s|$)/i.test(material);
}

function parseJvmHeapMb(value: string) {
  const match = String(value || '').match(/-Xmx(\d+(?:\.\d+)?)([kKmMgG]?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const bytes = unit === 'g' ? amount * 1024 ** 3 : unit === 'm' ? amount * MIB : unit === 'k' ? amount * 1024 : amount;
  return Math.max(1, Math.round(bytes / MIB));
}

export function resolveGradleRecoveryHeapPolicy(
  totalMemoryBytes = MACHINE_RUNTIME_PROFILE.totalMemoryBytesBucket,
  existingGradleOpts = process.env.GRADLE_OPTS || '',
) {
  const totalMb = Math.max(1, Math.floor(Number(totalMemoryBytes) / MIB));
  const safeExistingCeilingMb = Math.max(128, Math.floor(totalMb / 2));
  const heapPolicyCeilingMb = Math.max(128, Math.min(4096, safeExistingCeilingMb));
  const heapFloorMb = Math.min(1024, heapPolicyCeilingMb);
  const machineTargetMb = Math.min(heapPolicyCeilingMb, Math.max(heapFloorMb, Math.floor(totalMb / 4)));
  const existingHeapMb = parseJvmHeapMb(existingGradleOpts);
  const existingLargerSafe = existingHeapMb !== null && existingHeapMb > machineTargetMb && existingHeapMb <= safeExistingCeilingMb;
  return {
    heapMb: existingLargerSafe ? existingHeapMb : machineTargetMb,
    heapFloorMb,
    heapPolicyCeilingMb,
    safeExistingCeilingMb,
    existingHeapMb,
    heapSource: existingLargerSafe ? 'existing-larger-safe' as const : 'machine-policy' as const,
  };
}

function replaceGradleJvmHeap(existing: string, heapMb: number) {
  const raw = String(existing || '').trim();
  const xmx = /-Xmx\d+(?:\.\d+)?[kKmMgG]?/;
  if (xmx.test(raw)) return raw.replace(xmx, `-Xmx${heapMb}m`);
  return [raw, `-Dorg.gradle.jvmargs=-Xmx${heapMb}m`].filter(Boolean).join(' ');
}

function resolveCommandExecutionOptions(resolvedCommand: ResolvedCommand, args: Record<string, any>, baseTimeoutMs: number): CommandExecutionOptions {
  const rawProfile = args.recoveryProfile == null ? '' : String(args.recoveryProfile).trim();
  if (rawProfile && rawProfile !== VERIFICATION_RECOVERY_PROFILE) {
    throw createApiError(400, 'VERIFICATION_RECOVERY_PROFILE_INVALID', `Unsupported recoveryProfile '${rawProfile}'.`, {
      details: { allowed: [VERIFICATION_RECOVERY_PROFILE] },
    });
  }
  if (!rawProfile) {
    return { args: [...resolvedCommand.args], env: { ...process.env }, timeoutMs: baseTimeoutMs, recoveryProfile: null };
  }

  const gradleTuned = isGradleLikeCommand(resolvedCommand);
  const gradleHeapBaseline = [process.env.GRADLE_OPTS || '', resolvedCommand.script || '', ...resolvedCommand.args].join(' ');
  const heapPolicy = gradleTuned ? resolveGradleRecoveryHeapPolicy(MACHINE_RUNTIME_PROFILE.totalMemoryBytesBucket, gradleHeapBaseline) : null;
  const heapMb = heapPolicy?.heapMb ?? null;
  const executionArgs = [...resolvedCommand.args];
  if (gradleTuned && resolvedCommand.source === 'repository-config' && !executionArgs.some((entry) => /^--max-workers(?:=|$)/.test(entry))) {
    executionArgs.push('--max-workers=1');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVFLOW_VERIFICATION_RECOVERY: 'resource-safe',
    DEVFLOW_VERIFICATION_RECOVERY_ATTEMPT: '1',
  };
  if (gradleTuned && heapMb) env.GRADLE_OPTS = replaceGradleJvmHeap(process.env.GRADLE_OPTS || '', heapMb);
  const requestedTimeoutMs = Math.max(baseTimeoutMs, Math.ceil(baseTimeoutMs * 1.25));
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, requestedTimeoutMs);
  return {
    args: executionArgs,
    env,
    timeoutMs,
    recoveryProfile: {
      kind: 'resource-safe',
      attempt: 1,
      gradleTuned,
      heapMb,
      heapFloorMb: heapPolicy?.heapFloorMb ?? null,
      heapPolicyCeilingMb: heapPolicy?.heapPolicyCeilingMb ?? null,
      heapSafeExistingCeilingMb: heapPolicy?.safeExistingCeilingMb ?? null,
      existingHeapMb: heapPolicy?.existingHeapMb ?? null,
      heapSource: heapPolicy?.heapSource ?? null,
      maxWorkers: gradleTuned ? 1 : null,
      requestedTimeoutMs,
      timeoutMs,
      timeoutCapped: timeoutMs < requestedTimeoutMs,
      sharedResource: RECOVERY_SHARED_RESOURCE,
    },
  };
}

export function isVerificationInfrastructureFailure(result: Pick<RunProjectCommandResult, 'ok' | 'status' | 'timedOut' | 'signal' | 'stderr' | 'stdout'>) {
  if (result.ok) return false;
  if (result.timedOut || result.status === 'timed_out' || result.signal) return true;
  return INFRASTRUCTURE_FAILURE_OUTPUT.test(`${result.stderr || ''}\n${result.stdout || ''}`.slice(0, 12_000));
}

export function buildProjectCommandInfrastructureRecovery(state: AppState, args: Record<string, any>) {
  if (resolveInfrastructureRetryPolicy(args) !== 'resource-safe-once' || args.recoveryProfile) return null;
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(root, command, args);
  const baseTimeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const recoveryArgs = {
    ...args,
    recoveryProfile: VERIFICATION_RECOVERY_PROFILE,
    retryAttempt: 1,
    cacheResult: false,
    forceFresh: true,
  };
  const execution = resolveCommandExecutionOptions(resolvedCommand, recoveryArgs, baseTimeoutMs);
  return {
    args: recoveryArgs,
    profile: execution.recoveryProfile!,
  };
}

export function attachInfrastructureRecoveryAudit(
  firstFailure: RunProjectCommandResult,
  finalResult: RunProjectCommandResult,
  profile: VerificationInfrastructureRecoveryProfile,
): RunProjectCommandResult {
  const firstPerformance = firstFailure.performance;
  const finalPerformance = finalResult.performance;
  return {
    ...finalResult,
    processSpawns: Number(firstFailure.processSpawns || 0) + Number(finalResult.processSpawns || 0),
    durationMs: Number(firstFailure.durationMs || 0) + Number(finalResult.durationMs || 0),
    performance: finalPerformance ? {
      ...finalPerformance,
      executionMs: Number(firstPerformance?.executionMs || firstFailure.durationMs || 0) + Number(finalPerformance.executionMs || finalResult.durationMs || 0),
      totalMs: Number(firstPerformance?.totalMs || firstFailure.durationMs || 0) + Number(finalPerformance.totalMs || finalResult.durationMs || 0),
    } : finalPerformance,
    infrastructureRecovery: {
      policy: 'resource-safe-once',
      attempted: true,
      retryCount: 1,
      firstFailure: {
        failureClass: 'infrastructure',
        status: firstFailure.status,
        exitCode: firstFailure.exitCode,
        timedOut: firstFailure.timedOut,
        signal: firstFailure.signal,
        stderr: String(firstFailure.stderr || '').slice(0, 2_000),
      },
      profile,
      finalStatus: finalResult.status,
    },
  };
}

function attachNoInfrastructureRecoveryAudit(result: RunProjectCommandResult, args: Record<string, any>): RunProjectCommandResult {
  if (args.recoveryProfile || resolveInfrastructureRetryPolicy(args) !== 'resource-safe-once') return result;
  return {
    ...result,
    infrastructureRecovery: {
      policy: 'resource-safe-once',
      attempted: false,
      retryCount: 0,
      finalStatus: result.status,
    },
  };
}

export type ProjectCommandExecutionIdentity = {
  key: string;
  repoRevision: string;
  lineageToken: string;
  semanticKey: string;
  command: string;
  commandConfigFingerprint?: string;
  affectedInputFingerprint?: string;
  affectedInputPaths?: string[];
  dependencyFingerprint?: string;
  environmentFingerprint?: string;
  platform?: string;
  arch?: string;
  runtime?: string;
};

function buildProjectCommandExecutionIdentity(
  root: string,
  resolvedCommand: ResolvedCommand,
  cwdPath: string,
  timeoutMs: number,
  maxOutputBytes: number,
  responseMode: 'compact' | 'standard' | 'debug',
  overrides: {
    repoRevision?: string;
    lineageToken?: string;
    dependencyFingerprint?: string;
    affectedInputFingerprint?: string;
    affectedInputPaths?: string[];
  } = {},
  identityArgs: Record<string, any> = {},
): ProjectCommandExecutionIdentity | null {
  let observedRevision;
  try {
    observedRevision = getRepoRevisionForRoot(root);
  } catch {
    return null;
  }
  const repoRevision = overrides.repoRevision ?? observedRevision.token;
  const lineageToken = overrides.lineageToken ?? getRepoCacheLineage(root, [...PROJECT_COMMAND_CACHE_DEPENDENCIES]).token;
  const semanticKey = semanticKeyForResolvedCommand(root, resolvedCommand, cwdPath);
  const commandConfigFingerprint = resolvedCommand.source === 'repository-config'
    ? getProjectCommandConfigSnapshot(root).fingerprint
    : undefined;
  const lineageHead = repoRevision.split(':')[0] || observedRevision.head;
  const affectedInputs = overrides.affectedInputFingerprint
    ? {
        fingerprint: overrides.affectedInputFingerprint,
        paths: overrides.affectedInputPaths ? [...overrides.affectedInputPaths] : [],
      }
    : buildRepoAffectedInputIdentity(root, {
        ...observedRevision,
        token: repoRevision,
        head: lineageHead,
      }, identityArgs.affectedInputPaths ?? resolvedCommand.targets);
  const dependencyFingerprint = overrides.dependencyFingerprint ?? getRepoDependencyFingerprint(root);
  const environment = {
    CI: process.env.CI || '',
    NODE_ENV: process.env.NODE_ENV || '',
    NODE_OPTIONS: process.env.NODE_OPTIONS || '',
    GRADLE_OPTS: process.env.GRADLE_OPTS || '',
    machineRuntimeProfile: MACHINE_RUNTIME_PROFILE.key,
    infrastructureRetryPolicy: resolveInfrastructureRetryPolicy(identityArgs),
    recoveryProfile: identityArgs.recoveryProfile == null ? '' : String(identityArgs.recoveryProfile),
    recoveryHeapMb: identityArgs.recoveryProfile && isGradleLikeCommand(resolvedCommand)
      ? resolveGradleRecoveryHeapPolicy(
          MACHINE_RUNTIME_PROFILE.totalMemoryBytesBucket,
          [process.env.GRADLE_OPTS || '', resolvedCommand.script || '', ...resolvedCommand.args].join(' '),
        ).heapMb
      : null,
    retryAttempt: Number.isFinite(Number(identityArgs.retryAttempt)) ? Math.max(0, Math.floor(Number(identityArgs.retryAttempt))) : 0,
  };
  const environmentFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    runtime: process.version,
    environment,
  })).digest('hex');
  const identity = {
    revisionLineage: lineageHead,
    affectedInputFingerprint: affectedInputs.fingerprint,
    affectedInputPaths: affectedInputs.paths,
    semanticKey,
    cwd: path.relative(root, cwdPath) || '.',
    timeoutMs,
    maxOutputBytes,
    responseMode,
    source: resolvedCommand.source,
    configPath: resolvedCommand.configPath,
    commandConfigFingerprint,
    dependencyFingerprint,
    environmentFingerprint,
    platform: process.platform,
    arch: process.arch,
    runtime: process.version,
  };
  const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return {
    key,
    repoRevision,
    lineageToken,
    semanticKey,
    command: resolvedCommand.command,
    ...(commandConfigFingerprint ? { commandConfigFingerprint } : {}),
    affectedInputFingerprint: affectedInputs.fingerprint,
    affectedInputPaths: affectedInputs.paths,
    dependencyFingerprint,
    environmentFingerprint,
    platform: process.platform,
    arch: process.arch,
    runtime: process.version,
  };
}

export function getProjectCommandExecutionIdentity(state: AppState, args: Record<string, any>): ProjectCommandExecutionIdentity | null {
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(root, command, args);
  const cwdPath = resolveSafeCommandCwd(root, args.cwd ?? resolvedCommand.cwd);
  const baseTimeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execution = resolveCommandExecutionOptions(resolvedCommand, args, baseTimeoutMs);
  const { responseMode, maxOutputBytes } = resolveOutputBudget(args, resolvedCommand);
  return buildProjectCommandExecutionIdentity(root, resolvedCommand, cwdPath, execution.timeoutMs, maxOutputBytes, responseMode, {}, args);
}

export type ProjectCommandAdmissionPreflight = {
  executionIdentity: ProjectCommandExecutionIdentity | null;
  cachedResult: RunProjectCommandResult | null;
};

export type ProjectCommandVerificationExecutionIdentity = Omit<ProjectCommandExecutionIdentity, 'lineageToken'> & {
  lineageFingerprint: string;
};

export type ProjectCommandVerificationCandidate = VerificationCandidateIdentity & {
  executionIdentity: ProjectCommandVerificationExecutionIdentity;
};

function readProjectCommandVerificationCandidate(value: unknown): ProjectCommandVerificationCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as any;
  const executionIdentity = raw.executionIdentity as ProjectCommandVerificationExecutionIdentity | undefined;
  if (
    typeof raw.candidateId !== 'string'
    || typeof raw.repoRevision !== 'string'
    || typeof raw.snapshotCommit !== 'string'
    || typeof raw.createdAt !== 'string'
    || (raw.commandConfigFingerprint !== undefined && (typeof raw.commandConfigFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.commandConfigFingerprint)))
    || !executionIdentity
    || typeof executionIdentity.key !== 'string'
    || typeof executionIdentity.repoRevision !== 'string'
    || typeof executionIdentity.lineageFingerprint !== 'string'
    || typeof executionIdentity.semanticKey !== 'string'
    || typeof executionIdentity.command !== 'string'
    || (executionIdentity.commandConfigFingerprint !== undefined && (typeof executionIdentity.commandConfigFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(executionIdentity.commandConfigFingerprint)))
    || (executionIdentity.dependencyFingerprint !== undefined && (typeof executionIdentity.dependencyFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(executionIdentity.dependencyFingerprint)))
    || (executionIdentity.affectedInputFingerprint !== undefined && typeof executionIdentity.affectedInputFingerprint !== 'string')
    || (executionIdentity.affectedInputPaths !== undefined && (!Array.isArray(executionIdentity.affectedInputPaths) || executionIdentity.affectedInputPaths.some((entry) => typeof entry !== 'string')))
  ) {
    throw createApiError(400, 'VERIFICATION_CANDIDATE_INVALID', 'Project command verification candidate metadata is invalid.');
  }
  return {
    candidateId: raw.candidateId,
    repoRevision: raw.repoRevision,
    snapshotCommit: raw.snapshotCommit,
    createdAt: raw.createdAt,
    ...(raw.commandConfigFingerprint ? { commandConfigFingerprint: raw.commandConfigFingerprint } : {}),
    executionIdentity: { ...executionIdentity },
  };
}

export function bindProjectCommandVerificationCandidate(
  state: AppState,
  args: Record<string, any>,
  candidate: VerificationCandidateIdentity,
  options: {
    lineageToken?: string;
    dependencyFingerprint?: string;
    affectedInputFingerprint?: string;
    affectedInputPaths?: string[];
  } = {},
): ProjectCommandVerificationCandidate {
  const sourceRoot = resolveProjectRoot(state, args);
  const resolvedCandidate = resolveVerificationCandidate(candidate.candidateId);
  if (
    resolvedCandidate.repoRevision !== candidate.repoRevision
    || resolvedCandidate.snapshotCommit !== candidate.snapshotCommit
    || (candidate.commandConfigFingerprint !== undefined && resolvedCandidate.commandConfigFingerprint !== candidate.commandConfigFingerprint)
  ) {
    throw createApiError(409, 'VERIFICATION_CANDIDATE_MISMATCH', 'Verification candidate metadata no longer matches its immutable snapshot.');
  }
  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(resolvedCandidate.root, command, args);
  const cwdPath = resolveSafeCommandCwd(resolvedCandidate.root, args.cwd ?? resolvedCommand.cwd);
  const baseTimeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execution = resolveCommandExecutionOptions(resolvedCommand, args, baseTimeoutMs);
  const { responseMode, maxOutputBytes } = resolveOutputBudget(args, resolvedCommand);
  const lineageToken = options.lineageToken ?? getRepoCacheLineage(sourceRoot, [...PROJECT_COMMAND_CACHE_DEPENDENCIES]).token;
  const executionIdentity = buildProjectCommandExecutionIdentity(
    resolvedCandidate.root,
    resolvedCommand,
    cwdPath,
    execution.timeoutMs,
    maxOutputBytes,
    responseMode,
    {
      repoRevision: candidate.repoRevision,
      lineageToken,
      dependencyFingerprint: options.dependencyFingerprint,
      affectedInputFingerprint: options.affectedInputFingerprint,
      affectedInputPaths: options.affectedInputPaths,
    },
    args,
  );
  if (!executionIdentity) {
    throw createApiError(500, 'VERIFICATION_CANDIDATE_IDENTITY_FAILED', 'Verification candidate execution identity could not be created.');
  }
  return {
    ...candidate,
    executionIdentity: {
      key: executionIdentity.key,
      repoRevision: executionIdentity.repoRevision,
      lineageFingerprint: executionIdentity.lineageToken,
      semanticKey: executionIdentity.semanticKey,
      command: executionIdentity.command,
      ...(executionIdentity.commandConfigFingerprint ? { commandConfigFingerprint: executionIdentity.commandConfigFingerprint } : {}),
      ...(executionIdentity.dependencyFingerprint ? { dependencyFingerprint: executionIdentity.dependencyFingerprint } : {}),
      ...(executionIdentity.affectedInputFingerprint ? { affectedInputFingerprint: executionIdentity.affectedInputFingerprint } : {}),
      ...(executionIdentity.affectedInputPaths ? { affectedInputPaths: [...executionIdentity.affectedInputPaths] } : {}),
      ...(executionIdentity.environmentFingerprint ? { environmentFingerprint: executionIdentity.environmentFingerprint } : {}),
      ...(executionIdentity.platform ? { platform: executionIdentity.platform } : {}),
      ...(executionIdentity.arch ? { arch: executionIdentity.arch } : {}),
      ...(executionIdentity.runtime ? { runtime: executionIdentity.runtime } : {}),
    },
  };
}

export async function prepareProjectCommandVerificationCandidateAsync(
  state: AppState,
  args: Record<string, any>,
  options: { expectedExecutionKey?: string; signal?: AbortSignal } = {},
): Promise<ProjectCommandVerificationCandidate | null> {
  const sourceRoot = resolveProjectRoot(state, args);
  const descriptor = describeProjectCommand(state, args);
  if (descriptor.access !== 'verify') return null;

  const preparationIdentity = options.expectedExecutionKey
    ? getProjectCommandExecutionIdentity(state, args)
    : null;
  if (options.expectedExecutionKey && preparationIdentity?.key !== options.expectedExecutionKey) {
    throw createApiError(409, 'VERIFICATION_ADMISSION_STALE', 'Repository verification identity changed after job admission; refusing to verify a different revision.');
  }

  let candidate: VerificationCandidateIdentity;
  try {
    candidate = await createVerificationCandidateAsync(sourceRoot, { signal: options.signal });
  } catch (error: any) {
    const code = error?.payload?.code || error?.code;
    if (code === 'NOT_GIT_REPO') return null;
    throw error;
  }
  try {
    const bound = bindProjectCommandVerificationCandidate(
      state,
      args,
      candidate,
      preparationIdentity
        ? {
            lineageToken: preparationIdentity.lineageToken,
            dependencyFingerprint: preparationIdentity.dependencyFingerprint,
            affectedInputFingerprint: preparationIdentity.affectedInputFingerprint,
            affectedInputPaths: preparationIdentity.affectedInputPaths,
          }
        : {},
    );
    if (options.expectedExecutionKey && bound.executionIdentity.key !== options.expectedExecutionKey) {
      const comparableFields = [
        'repoRevision',
        'semanticKey',
        'command',
        'commandConfigFingerprint',
        'affectedInputFingerprint',
        'dependencyFingerprint',
        'environmentFingerprint',
        'platform',
        'arch',
        'runtime',
      ] as const;
      const mismatchedFields = preparationIdentity
        ? comparableFields.filter((field) => preparationIdentity[field] !== bound.executionIdentity[field])
        : [];
      const mismatchSummary = mismatchedFields.length > 0 ? mismatchedFields.join(',') : 'unexposed-key-material';
      throw createApiError(409, 'VERIFICATION_ADMISSION_STALE', `Repository verification identity changed after job admission; refusing to verify a different revision. Candidate-bind mismatch: ${mismatchSummary}.`, {
        details: {
          stage: 'candidate-bind',
          mismatchedFields,
          admissionKey: options.expectedExecutionKey,
          candidateKey: bound.executionIdentity.key,
        },
      });
    }
    return bound;
  } catch (error) {
    await releaseVerificationCandidateAsync(candidate.candidateId).catch(() => {});
    throw error;
  }
}

export function prepareProjectCommandVerificationCandidate(
  state: AppState,
  args: Record<string, any>,
): ProjectCommandVerificationCandidate | null {
  const sourceRoot = resolveProjectRoot(state, args);
  const descriptor = describeProjectCommand(state, args);
  if (descriptor.access !== 'verify') return null;

  let candidate: VerificationCandidateIdentity;
  try {
    candidate = createVerificationCandidate(sourceRoot);
  } catch (error: any) {
    const code = error?.payload?.code || error?.code;
    if (code === 'NOT_GIT_REPO') return null;
    throw error;
  }
  try {
    return bindProjectCommandVerificationCandidate(state, args, candidate);
  } catch (error) {
    releaseVerificationCandidate(candidate.candidateId);
    throw error;
  }
}

function withVerificationCandidate(
  result: RunProjectCommandResult,
  sourceRoot: string,
  candidate: ProjectCommandVerificationCandidate | null,
  executionIdentity: ProjectCommandExecutionIdentity | null,
): RunProjectCommandResult {
  if (!candidate || !executionIdentity) return result;
  return {
    ...result,
    verificationCandidate: {
      candidateId: candidate.candidateId,
      repoRevision: candidate.repoRevision,
      snapshotCommit: candidate.snapshotCommit,
      executionKey: executionIdentity.key,
      current: isVerificationCandidateCurrent(sourceRoot, candidate, candidate.executionIdentity.commandConfigFingerprint),
    },
  };
}

function commandCacheContext(
  root: string,
  resolvedCommand: ResolvedCommand,
  cwdPath: string,
  timeoutMs: number,
  maxOutputBytes: number,
  responseMode: 'compact' | 'standard' | 'debug',
  args: Record<string, any>,
  identityOverride?: ProjectCommandExecutionIdentity | null,
) {
  const explicitCache = args.cacheResult === true || String(args.cacheResult).toLowerCase() === 'true';
  const explicitlyDisabled = args.cacheResult === false || String(args.cacheResult).toLowerCase() === 'false';
  const automaticStaticCache = resolvedCommand.command === 'typecheck' || resolvedCommand.command === 'lint';
  if (explicitlyDisabled || (!explicitCache && !automaticStaticCache)) return null;
  const executionIdentity = identityOverride ?? buildProjectCommandExecutionIdentity(root, resolvedCommand, cwdPath, timeoutMs, maxOutputBytes, responseMode, {}, args);
  if (!executionIdentity) return null;
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
    executionKey: executionIdentity.key,
    lineageToken: executionIdentity.lineageToken,
  })).digest('hex');
  return { ...executionIdentity, key: cacheKey };
}

function cachedCommandResult(
  cacheContext: ReturnType<typeof commandCacheContext>,
  command: string,
  resolutionMs = 0,
  responseMode: 'compact' | 'standard' | 'debug' = 'standard',
  args: Record<string, any> = {},
) {
  if (!cacheContext) return null;
  const consumerId = typeof args.evidenceConsumerId === 'string' ? args.evidenceConsumerId : undefined;
  const cached = getCachedCommandResult<RunProjectCommandResult>(cacheContext.key, consumerId);
  recordRepoCacheAccess('verification-results', Boolean(cached));
  if (!cached) return null;
  return {
    ...cached.value,
    command,
    durationMs: 0,
    responseMode,
    processSpawns: 0,
    performance: {
      resolutionMs,
      executionMs: 0,
    },
    cache: {
      hit: true,
      key: cacheContext.key,
      repoRevision: cacheContext.repoRevision,
      lineageToken: cacheContext.lineageToken,
      cachedAt: new Date(cached.createdAt).toISOString(),
      originalDurationMs: cached.value.durationMs,
      ...(cached.evidence?.evidenceId ? { evidenceId: cached.evidence.evidenceId } : {}),
      ...(cached.evidence?.sourceConsumerId ? { sourceConsumerId: cached.evidence.sourceConsumerId } : {}),
      ...(cached.evidence ? { consumers: [...cached.evidence.consumers], reusable: cached.evidence.reusable } : {}),
      affectedInputFingerprint: cacheContext.affectedInputFingerprint,
      dependencyFingerprint: cacheContext.dependencyFingerprint,
      environmentFingerprint: cacheContext.environmentFingerprint,
    },
  } satisfies RunProjectCommandResult;
}

export function getProjectCommandAdmissionPreflight(
  state: AppState,
  args: Record<string, any>,
): ProjectCommandAdmissionPreflight {
  const totalStartedAt = Date.now();
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(root, command, args);
  const cwdPath = resolveSafeCommandCwd(root, args.cwd ?? resolvedCommand.cwd);
  const baseTimeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execution = resolveCommandExecutionOptions(resolvedCommand, args, baseTimeoutMs);
  const timeoutMs = execution.timeoutMs;
  const { responseMode, maxOutputBytes } = resolveOutputBudget(args, resolvedCommand);
  const executionIdentity = buildProjectCommandExecutionIdentity(root, resolvedCommand, cwdPath, timeoutMs, maxOutputBytes, responseMode, {}, args);
  const resolutionMs = Date.now() - totalStartedAt;
  const cacheLookupStartedAt = Date.now();
  const cacheContext = commandCacheContext(root, resolvedCommand, cwdPath, timeoutMs, maxOutputBytes, responseMode, args, executionIdentity);
  const cached = args.forceFresh === true ? null : cachedCommandResult(cacheContext, command, resolutionMs, responseMode, args);
  const cacheLookupMs = Date.now() - cacheLookupStartedAt;
  return {
    executionIdentity,
    cachedResult: cached ? withPerformancePhases(cached, {
      resolutionMs,
      cacheLookupMs,
      resultNormalizationMs: 0,
      totalMs: Date.now() - totalStartedAt,
    }) : null,
  };
}

function rememberSuccessfulCommandResult(
  cacheContext: ReturnType<typeof commandCacheContext>,
  result: RunProjectCommandResult,
  args: Record<string, any>,
) {
  if (!cacheContext) return result;
  const retryAttempt = Number.isFinite(Number(args.retryAttempt)) ? Math.max(0, Math.floor(Number(args.retryAttempt))) : 0;
  const lowConfidence = String(args.verificationConfidence || '').toLowerCase() === 'low' || retryAttempt > 0 || args.flaky === true;
  const reusable = !lowConfidence || args.allowLowConfidenceEvidenceReuse === true;
  const sourceConsumerId = typeof args.evidenceConsumerId === 'string' ? args.evidenceConsumerId : undefined;
  const remembered = result.ok && reusable
    ? rememberCommandResult(cacheContext.key, result, args.cacheTtlMs, { sourceConsumerId, reusable: true })
    : null;
  return {
    ...result,
    cache: {
      hit: false,
      key: cacheContext.key,
      repoRevision: cacheContext.repoRevision,
      lineageToken: cacheContext.lineageToken,
      originalDurationMs: result.durationMs,
      reusable,
      ...(remembered?.evidence?.evidenceId ? { evidenceId: remembered.evidence.evidenceId } : {}),
      ...(remembered?.evidence?.sourceConsumerId ? { sourceConsumerId: remembered.evidence.sourceConsumerId } : {}),
      ...(remembered?.evidence ? { consumers: [...remembered.evidence.consumers] } : {}),
      affectedInputFingerprint: cacheContext.affectedInputFingerprint,
      dependencyFingerprint: cacheContext.dependencyFingerprint,
      environmentFingerprint: cacheContext.environmentFingerprint,
    },
  } satisfies RunProjectCommandResult;
}

export function runProjectCommand(state: AppState, args: Record<string, any>): RunProjectCommandResult {
  const totalStartedAt = Date.now();
  const resolutionStartedAt = totalStartedAt;
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(root, command, args);
  const cwdPath = resolveSafeCommandCwd(root, args.cwd ?? resolvedCommand.cwd);
  const baseTimeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execution = resolveCommandExecutionOptions(resolvedCommand, args, baseTimeoutMs);
  const timeoutMs = execution.timeoutMs;
  const { responseMode, maxOutputBytes } = resolveOutputBudget(args, resolvedCommand);
  const resolutionMs = Date.now() - resolutionStartedAt;

  const cacheLookupStartedAt = Date.now();
  const cacheContext = commandCacheContext(root, resolvedCommand, cwdPath, timeoutMs, maxOutputBytes, responseMode, args);
  const cached = args.forceFresh === true ? null : cachedCommandResult(cacheContext, command, resolutionMs, responseMode, args);
  const cacheLookupMs = Date.now() - cacheLookupStartedAt;
  if (cached) {
    return withPerformancePhases(cached, {
      resolutionMs,
      cacheLookupMs,
      resultNormalizationMs: 0,
      totalMs: Date.now() - totalStartedAt,
    });
  }

  const commandDescriptor = buildProjectCommandDescriptor(root, command, resolvedCommand, cwdPath);
  const resourceDescriptor = resourceProfileDescriptorFor(root, commandDescriptor, args);
  const resourcePrediction = predictVerificationResourceCost(resourceDescriptor);
  const systemResourceStart = captureSystemResourceSnapshot();
  const startedAt = Date.now();
  const result = spawnSync(resolvedCommand.executable, execution.args, {
    cwd: cwdPath,
    shell: false,
    encoding: 'utf8',
    env: execution.env,
    timeout: timeoutMs,
    maxBuffer: Math.max(maxOutputBytes * 4, 1_000_000),
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = Boolean(result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT');

  if (result.error && !timedOut) {
    throw createApiError(500, 'COMMAND_EXEC_ERROR', `Failed to run '${command}'.`, {
      details: result.error.message,
    });
  }

  const resultNormalizationStartedAt = Date.now();
  const commandResult = buildCommandResult({
    command,
    root,
    cwdPath,
    exitCode: result.status,
    durationMs,
    timedOut,
    signal: result.signal,
    stdoutRaw: result.stdout || '',
    stderrRaw: result.stderr || '',
    maxOutputBytes,
    responseMode,
    resolutionMs,
  });
  const resultNormalizationMs = Date.now() - resultNormalizationStartedAt;
  const finalizedResult = withPerformancePhases(commandResult, {
    resolutionMs,
    cacheLookupMs,
    resultNormalizationMs,
    totalMs: Date.now() - totalStartedAt,
  });
  const resourceProfile = finalizeResourceProfile(
    resourceDescriptor,
    resourcePrediction,
    systemResourceStart,
    durationMs,
    finalizedResult.status,
  );
  const completed = rememberSuccessfulCommandResult(cacheContext, { ...finalizedResult, resourceProfile }, args);
  if (!args.recoveryProfile && isVerificationInfrastructureFailure(completed)) {
    const recovery = buildProjectCommandInfrastructureRecovery(state, args);
    if (recovery) {
      const retried = runProjectCommand(state, recovery.args);
      return attachInfrastructureRecoveryAudit(completed, retried, recovery.profile);
    }
  }
  return attachNoInfrastructureRecoveryAudit(completed, args);
}

type KillableCommandProcess = {
  pid?: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

export function terminateCommandProcess(
  child: KillableCommandProcess,
  options: { platform?: NodeJS.Platform; treeTerminator?: typeof terminateProcessTree } = {},
) {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' && child.pid) {
    const treeResult = (options.treeTerminator ?? terminateProcessTree)(child.pid, { platform: 'win32' });
    if (treeResult.terminated) return { mode: 'process-tree' as const, ...treeResult };
  }
  const terminated = child.kill('SIGTERM');
  return { mode: 'root-signal' as const, attempted: true, treeTermination: false, terminated };
}

export async function runProjectCommandAsync(state: AppState, args: Record<string, any>, logger: { stdout: (data: string) => void, stderr: (data: string) => void }, setCancelFn: (fn: () => void) => void): Promise<RunProjectCommandResult> {
  const totalStartedAt = Date.now();
  const resolutionStartedAt = totalStartedAt;
  const sourceRoot = resolveProjectRoot(state, args);
  const suppliedCandidate = readProjectCommandVerificationCandidate(args.__verificationCandidate);
  let executionRoot = sourceRoot;
  if (suppliedCandidate) {
    const resolvedCandidate = resolveVerificationCandidate(suppliedCandidate.candidateId);
    if (
      resolvedCandidate.repoRevision !== suppliedCandidate.repoRevision
      || resolvedCandidate.snapshotCommit !== suppliedCandidate.snapshotCommit
      || (suppliedCandidate.commandConfigFingerprint !== undefined && resolvedCandidate.commandConfigFingerprint !== suppliedCandidate.commandConfigFingerprint)
      || suppliedCandidate.executionIdentity.repoRevision !== suppliedCandidate.repoRevision
    ) {
      throw createApiError(409, 'VERIFICATION_CANDIDATE_MISMATCH', 'Verification candidate metadata no longer matches its immutable snapshot.');
    }
    executionRoot = resolvedCandidate.root;
  }

  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(executionRoot, command, args);
  const executionCwdPath = resolveSafeCommandCwd(executionRoot, args.cwd ?? resolvedCommand.cwd);
  const displayCwdPath = suppliedCandidate
    ? resolveSafeCommandCwd(sourceRoot, args.cwd ?? resolvedCommand.cwd)
    : executionCwdPath;
  const baseTimeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execution = resolveCommandExecutionOptions(resolvedCommand, args, baseTimeoutMs);
  const timeoutMs = execution.timeoutMs;
  const { responseMode, maxOutputBytes } = resolveOutputBudget(args, resolvedCommand);

  let executionIdentity: ProjectCommandExecutionIdentity | null = null;
  if (suppliedCandidate) {
    const candidateIdentityOverrides = {
      repoRevision: suppliedCandidate.repoRevision,
      lineageToken: suppliedCandidate.executionIdentity.lineageFingerprint,
      dependencyFingerprint: suppliedCandidate.executionIdentity.dependencyFingerprint,
      affectedInputFingerprint: suppliedCandidate.executionIdentity.affectedInputFingerprint,
      affectedInputPaths: suppliedCandidate.executionIdentity.affectedInputPaths,
    };
    executionIdentity = buildProjectCommandExecutionIdentity(
      executionRoot,
      resolvedCommand,
      executionCwdPath,
      timeoutMs,
      maxOutputBytes,
      responseMode,
      candidateIdentityOverrides,
      args,
    );
    if (!executionIdentity || executionIdentity.key !== suppliedCandidate.executionIdentity.key) {
      throw createApiError(409, 'VERIFICATION_CANDIDATE_IDENTITY_MISMATCH', 'Verification command no longer matches the captured candidate execution identity.');
    }
  }
  const resolutionMs = Date.now() - resolutionStartedAt;

  const cacheLookupStartedAt = Date.now();
  const cacheContext = commandCacheContext(
    executionRoot,
    resolvedCommand,
    executionCwdPath,
    timeoutMs,
    maxOutputBytes,
    responseMode,
    args,
    executionIdentity,
  );
  const cached = args.forceFresh === true ? null : cachedCommandResult(cacheContext, command, resolutionMs, responseMode, args);
  const cacheLookupMs = Date.now() - cacheLookupStartedAt;
  if (cached) {
    return withVerificationCandidate(withPerformancePhases(cached, {
      resolutionMs,
      cacheLookupMs,
      resultNormalizationMs: 0,
      totalMs: Date.now() - totalStartedAt,
    }), sourceRoot, suppliedCandidate, executionIdentity);
  }

  const commandDescriptor = buildProjectCommandDescriptor(executionRoot, command, resolvedCommand, executionCwdPath);
  const resourceDescriptor = resourceProfileDescriptorFor(sourceRoot, commandDescriptor, args);
  const resourcePrediction = predictVerificationResourceCost(resourceDescriptor);
  const systemResourceStart = captureSystemResourceSnapshot();
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const spawnStartedAt = Date.now();
    const child = spawn(resolvedCommand.executable, execution.args, {
      cwd: executionCwdPath,
      shell: false,
      env: execution.env,
    });

    let processStartupMs: number | undefined;
    child.once('spawn', () => {
      processStartupMs = Date.now() - spawnStartedAt;
    });

    let timedOut = false;
    const stdoutCapture = createBoundedCommandOutputCapture(maxOutputBytes);
    const stderrCapture = createBoundedCommandOutputCapture(maxOutputBytes);
    const processAggregate: ProcessResourceAggregate = { attempts: 0, samples: 0, completeSamples: 0, partialSamples: 0 };
    let resourceSampleInterval: NodeJS.Timeout | undefined;
    const sampleChildResources = () => {
      if (!child.pid) return;
      processAggregate.attempts += 1;
      const sample = sampleProcessTreeResources(child.pid);
      if (!sample.supported) return;
      processAggregate.samples += 1;
      if (sample.cpuRatio !== undefined) processAggregate.maxCpuRatio = Math.max(processAggregate.maxCpuRatio ?? 0, sample.cpuRatio);
      if (sample.memoryAccounting === 'complete' && sample.treeAccounting) {
        processAggregate.completeSamples += 1;
        if (sample.rssBytes !== undefined) processAggregate.maxRssBytes = Math.max(processAggregate.maxRssBytes ?? 0, sample.rssBytes);
        if (sample.processCount !== undefined) processAggregate.maxProcessCount = Math.max(processAggregate.maxProcessCount ?? 0, sample.processCount);
      } else if (sample.memoryAccounting === 'partial') {
        processAggregate.partialSamples += 1;
        if (sample.rssBytes !== undefined) processAggregate.maxPartialRssBytes = Math.max(processAggregate.maxPartialRssBytes ?? 0, sample.rssBytes);
      }
    };
    const resourceSampleDelay = setTimeout(() => {
      sampleChildResources();
      resourceSampleInterval = setInterval(sampleChildResources, PROCESS_RESOURCE_SAMPLE_INTERVAL_MS);
      resourceSampleInterval.unref?.();
    }, PROCESS_RESOURCE_SAMPLE_DELAY_MS);
    resourceSampleDelay.unref?.();
    const clearResourceSampling = () => {
      clearTimeout(resourceSampleDelay);
      if (resourceSampleInterval) clearInterval(resourceSampleInterval);
      resourceSampleInterval = undefined;
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      terminateCommandProcess(child);
    }, timeoutMs);

    setCancelFn(() => {
      clearTimeout(timeoutId);
      clearResourceSampling();
      terminateCommandProcess(child);
      reject(new Error('Job cancelled'));
    });

    child.stdout.on('data', (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      stdoutCapture.append(buffer);
      logger.stdout(buffer.toString('utf8'));
    });

    child.stderr.on('data', (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      stderrCapture.append(buffer);
      logger.stderr(buffer.toString('utf8'));
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      clearResourceSampling();
      reject(createApiError(500, 'COMMAND_EXEC_ERROR', `Failed to run '${command}'.`, { details: err.message }));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      clearResourceSampling();
      const durationMs = Date.now() - startedAt;

      const resultNormalizationStartedAt = Date.now();
      const stdoutSnapshot = stdoutCapture.snapshot();
      const stderrSnapshot = stderrCapture.snapshot();
      const commandResult = buildCommandResult({
        command,
        root: sourceRoot,
        cwdPath: displayCwdPath,
        exitCode: code,
        durationMs,
        timedOut,
        signal,
        stdoutRaw: stdoutSnapshot.value,
        stderrRaw: stderrSnapshot.value,
        stdoutBytesTotal: stdoutSnapshot.bytes,
        stderrBytesTotal: stderrSnapshot.bytes,
        maxOutputBytes,
        responseMode,
        resolutionMs,
      });
      const resultNormalizationMs = Date.now() - resultNormalizationStartedAt;
      const finalizedResult = withPerformancePhases(commandResult, {
        resolutionMs,
        cacheLookupMs,
        processStartupMs,
        resultNormalizationMs,
        totalMs: Date.now() - totalStartedAt,
      });
      const resourceProfile = finalizeResourceProfile(
        resourceDescriptor,
        resourcePrediction,
        systemResourceStart,
        durationMs,
        finalizedResult.status,
        processAggregate,
      );
      const candidateResult = withVerificationCandidate({ ...finalizedResult, resourceProfile }, sourceRoot, suppliedCandidate, executionIdentity);
      resolve(attachNoInfrastructureRecoveryAudit(rememberSuccessfulCommandResult(cacheContext, candidateResult, args), args));
    });
  });
}
