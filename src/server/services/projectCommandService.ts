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
      processCount?: number;
      processTreeAccounting: boolean;
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
    `Command '${normalized || String(value || '')}' is not a valid verification preset name. Use a built-in package script or define it in .devflow/commands.yaml.`,
    { affectedId: normalized || undefined },
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

  if (!isBuiltIn) {
    throw createApiError(400, 'COMMAND_NOT_ALLOWED', `Command '${command}' is not a built-in verification preset and is not defined in .devflow/commands.yaml or .devflow/commands.json.`, {
      affectedId: command,
      details: { nextAction: `Define commands.${command} with executable and args in .devflow/commands.yaml.` },
    });
  }

  throw createApiError(400, 'COMMAND_NOT_CONFIGURED', `Verification command '${command}' is not configured. Add a package.json script or a repository command preset.`, {
    affectedId: command,
    details: { packageJsonFound: packageConfig.exists, nextAction: `Configure '${command}' in package.json scripts or .devflow/commands.yaml.` },
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
  treeAccounting: boolean;
  maxCpuRatio?: number;
  maxRssBytes?: number;
  maxProcessCount?: number;
};

function finalizeResourceProfile(
  descriptor: VerificationResourceProfileDescriptor,
  prediction: VerificationResourcePrediction,
  systemStart: ReturnType<typeof captureSystemResourceSnapshot>,
  durationMs: number,
  status: CommandStatus,
  processAggregate: ProcessResourceAggregate = { attempts: 0, samples: 0, treeAccounting: false },
) {
  const systemDelta = diffSystemResourceSnapshots(systemStart, captureSystemResourceSnapshot());
  const actualCpuRatio = processAggregate.maxCpuRatio ?? systemDelta.cpuUtilization;
  const actual = {
    durationMs,
    systemCpuRatio: systemDelta.cpuUtilization,
    memoryPressureRatio: systemDelta.peakMemoryPressure,
    ...(actualCpuRatio !== undefined ? { cpuRatio: actualCpuRatio } : {}),
    ...(processAggregate.maxRssBytes !== undefined ? { memoryBytes: processAggregate.maxRssBytes } : {}),
    ...(processAggregate.maxProcessCount !== undefined ? { processCount: processAggregate.maxProcessCount } : {}),
    processTreeAccounting: processAggregate.treeAccounting,
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
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { responseMode, maxOutputBytes } = resolveOutputBudget(args, resolvedCommand);
  return buildProjectCommandExecutionIdentity(root, resolvedCommand, cwdPath, timeoutMs, maxOutputBytes, responseMode, {}, args);
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
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { responseMode, maxOutputBytes } = resolveOutputBudget(args, resolvedCommand);
  const lineageToken = options.lineageToken ?? getRepoCacheLineage(sourceRoot, [...PROJECT_COMMAND_CACHE_DEPENDENCIES]).token;
  const executionIdentity = buildProjectCommandExecutionIdentity(
    resolvedCandidate.root,
    resolvedCommand,
    cwdPath,
    timeoutMs,
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
  return identityOverride ?? buildProjectCommandExecutionIdentity(root, resolvedCommand, cwdPath, timeoutMs, maxOutputBytes, responseMode, {}, args);
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
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  const result = spawnSync(resolvedCommand.executable, resolvedCommand.args, {
    cwd: cwdPath,
    shell: false,
    encoding: 'utf8',
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
  return rememberSuccessfulCommandResult(cacheContext, { ...finalizedResult, resourceProfile }, args);
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
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const child = spawn(resolvedCommand.executable, resolvedCommand.args, {
      cwd: executionCwdPath,
      shell: false,
    });

    let processStartupMs: number | undefined;
    child.once('spawn', () => {
      processStartupMs = Date.now() - spawnStartedAt;
    });

    let timedOut = false;
    const stdoutCapture = createBoundedCommandOutputCapture(maxOutputBytes);
    const stderrCapture = createBoundedCommandOutputCapture(maxOutputBytes);
    const processAggregate: ProcessResourceAggregate = { attempts: 0, samples: 0, treeAccounting: false };
    let resourceSampleInterval: NodeJS.Timeout | undefined;
    const sampleChildResources = () => {
      if (!child.pid) return;
      processAggregate.attempts += 1;
      const sample = sampleProcessTreeResources(child.pid);
      if (!sample.supported) return;
      processAggregate.samples += 1;
      processAggregate.treeAccounting = processAggregate.treeAccounting || sample.treeAccounting;
      if (sample.cpuRatio !== undefined) {
        processAggregate.maxCpuRatio = Math.max(processAggregate.maxCpuRatio ?? 0, sample.cpuRatio);
      }
      if (sample.rssBytes !== undefined) {
        processAggregate.maxRssBytes = Math.max(processAggregate.maxRssBytes ?? 0, sample.rssBytes);
      }
      if (sample.processCount !== undefined) {
        processAggregate.maxProcessCount = Math.max(processAggregate.maxProcessCount ?? 0, sample.processCount);
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
      child.kill('SIGTERM');
    }, timeoutMs);

    setCancelFn(() => {
      clearTimeout(timeoutId);
      clearResourceSampling();
      child.kill('SIGTERM');
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
      resolve(rememberSuccessfulCommandResult(cacheContext, candidateResult, args));
    });
  });
}
