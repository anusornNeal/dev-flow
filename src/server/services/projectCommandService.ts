import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { resolvePackageManagerInvocation } from '../../lib/platformRuntime';
import type { AppState } from '../types';
import { createApiError } from './api';
import { resolveProjectRoot, resolveSafePath } from './localFileService';
import { loadProjectCommandPreset } from './projectCommandConfigService';
import { getRepoRevisionForRoot } from './repoRevisionService';
import { getCachedCommandResult, rememberCommandResult } from './commandResultCacheService';
import { readWorkspaceMetadataFile } from './workspaceMetadataCacheService';
import { getRepoCacheLineage, recordRepoCacheAccess, registerRepoCacheInvalidator } from './repoCacheInvalidationService';

const ALLOWED_COMMANDS = ['typecheck', 'test', 'lint', 'build', 'verify'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 12_000;
const COMPACT_MAX_OUTPUT_BYTES = 2_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 100_000;
const MAX_PACKAGE_JSON_BYTES = 10 * 1024 * 1024;
const packageScriptsParseCache = new Map<string, { size: number; mtimeMs: number; scripts: Record<string, string> }>();
const PROJECT_COMMAND_CACHE_DEPENDENCIES = ['repo-content', 'repo-revision', 'project-rules'] as const;

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
};

export type ProjectCommandScope = 'targeted' | 'broad' | 'full';
export type ProjectCommandCost = 'low' | 'medium' | 'high';
export type ProjectCommandAccess = 'verify' | 'write';

export type ProjectCommandDescriptor = {
  command: string;
  semanticKey: string;
  scope: ProjectCommandScope;
  cost: ProjectCommandCost;
  access: ProjectCommandAccess;
  resourceKey: string;
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
  cache?: {
    hit: boolean;
    key: string;
    repoRevision: string;
    lineageToken?: string;
    cachedAt?: string;
    originalDurationMs?: number;
  };
}

function truncateOutput(value: string, maxBytes: number) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) {
    return { value, bytes, truncated: false };
  }

  return {
    value: `${Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[truncated]`,
    bytes,
    truncated: true,
  };
}

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
  maxOutputBytes: number;
  responseMode?: 'compact' | 'standard' | 'debug';
  resolutionMs?: number;
}): RunProjectCommandResult {
  const stdout = truncateOutput(input.stdoutRaw || '', input.maxOutputBytes);
  const stderr = truncateOutput(input.stderrRaw || '', input.maxOutputBytes);
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

function resolveAllowedCommand(root: string, command: string): ResolvedCommand {
  const packageConfig = readPackageScripts(root);
  const isBuiltIn = (ALLOWED_COMMANDS as readonly string[]).includes(command);
  if (isBuiltIn && packageConfig.scripts[command]) {
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
    return {
      command,
      executable: configured.executable,
      args: configured.args,
      cwd: configured.cwd,
      timeoutMs: configured.timeoutMs,
      maxOutputBytes: configured.maxOutputBytes,
      source: 'repository-config',
      configPath: configured.configPath,
      category: configured.category,
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
        executable: resolvedCommand.executable,
        args: resolvedCommand.args,
        cwd: path.relative(root, cwdPath) || '.',
        configPath: resolvedCommand.configPath,
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

export function describeProjectCommand(state: AppState, args: Record<string, any>): ProjectCommandDescriptor {
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(root, command);
  const cwdPath = resolveSafeCommandCwd(root, args.cwd ?? resolvedCommand.cwd);
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

  return {
    command,
    semanticKey,
    scope,
    cost,
    access,
    resourceKey,
    executable: resolvedCommand.executable,
    args: [...resolvedCommand.args],
    cwd: path.relative(root, cwdPath) || '.',
    source: resolvedCommand.source,
    ...(resolvedCommand.configPath ? { configPath: resolvedCommand.configPath } : {}),
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
};

function buildProjectCommandExecutionIdentity(
  root: string,
  resolvedCommand: ResolvedCommand,
  cwdPath: string,
  timeoutMs: number,
  maxOutputBytes: number,
  responseMode: 'compact' | 'standard' | 'debug',
): ProjectCommandExecutionIdentity | null {
  let revision;
  try {
    revision = getRepoRevisionForRoot(root);
  } catch {
    return null;
  }
  const lineageToken = getRepoCacheLineage(root, [...PROJECT_COMMAND_CACHE_DEPENDENCIES]).token;
  const semanticKey = semanticKeyForResolvedCommand(root, resolvedCommand, cwdPath);
  const identity = {
    repoRevision: revision.token,
    lineageToken,
    semanticKey,
    cwd: path.relative(root, cwdPath) || '.',
    timeoutMs,
    maxOutputBytes,
    responseMode,
    source: resolvedCommand.source,
    configPath: resolvedCommand.configPath,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    env: {
      CI: process.env.CI || '',
      NODE_ENV: process.env.NODE_ENV || '',
      NODE_OPTIONS: process.env.NODE_OPTIONS || '',
    },
  };
  const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return { key, repoRevision: revision.token, lineageToken, semanticKey, command: resolvedCommand.command };
}

export function getProjectCommandExecutionIdentity(state: AppState, args: Record<string, any>): ProjectCommandExecutionIdentity | null {
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(root, command);
  const cwdPath = resolveSafeCommandCwd(root, args.cwd ?? resolvedCommand.cwd);
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { responseMode, maxOutputBytes } = resolveOutputBudget(args, resolvedCommand);
  return buildProjectCommandExecutionIdentity(root, resolvedCommand, cwdPath, timeoutMs, maxOutputBytes, responseMode);
}

function commandCacheContext(
  root: string,
  resolvedCommand: ResolvedCommand,
  cwdPath: string,
  timeoutMs: number,
  maxOutputBytes: number,
  responseMode: 'compact' | 'standard' | 'debug',
  args: Record<string, any>,
) {
  const explicitCache = args.cacheResult === true || String(args.cacheResult).toLowerCase() === 'true';
  const explicitlyDisabled = args.cacheResult === false || String(args.cacheResult).toLowerCase() === 'false';
  const automaticStaticCache = resolvedCommand.command === 'typecheck' || resolvedCommand.command === 'lint';
  if (explicitlyDisabled || (!explicitCache && !automaticStaticCache)) return null;
  return buildProjectCommandExecutionIdentity(root, resolvedCommand, cwdPath, timeoutMs, maxOutputBytes, responseMode);
}

function cachedCommandResult(
  cacheContext: ReturnType<typeof commandCacheContext>,
  command: string,
  resolutionMs = 0,
  responseMode: 'compact' | 'standard' | 'debug' = 'standard',
) {
  if (!cacheContext) return null;
  const cached = getCachedCommandResult<RunProjectCommandResult>(cacheContext.key);
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
    },
  } satisfies RunProjectCommandResult;
}

function rememberSuccessfulCommandResult(
  cacheContext: ReturnType<typeof commandCacheContext>,
  result: RunProjectCommandResult,
  args: Record<string, any>,
) {
  if (!cacheContext) return result;
  if (result.ok) rememberCommandResult(cacheContext.key, result, args.cacheTtlMs);
  return {
    ...result,
    cache: {
      hit: false,
      key: cacheContext.key,
      repoRevision: cacheContext.repoRevision,
      lineageToken: cacheContext.lineageToken,
      originalDurationMs: result.durationMs,
    },
  } satisfies RunProjectCommandResult;
}

export function runProjectCommand(state: AppState, args: Record<string, any>): RunProjectCommandResult {
  const totalStartedAt = Date.now();
  const resolutionStartedAt = totalStartedAt;
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(root, command);
  const cwdPath = resolveSafeCommandCwd(root, args.cwd ?? resolvedCommand.cwd);
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { responseMode, maxOutputBytes } = resolveOutputBudget(args, resolvedCommand);
  const resolutionMs = Date.now() - resolutionStartedAt;

  const cacheLookupStartedAt = Date.now();
  const cacheContext = commandCacheContext(root, resolvedCommand, cwdPath, timeoutMs, maxOutputBytes, responseMode, args);
  const cached = args.forceFresh === true ? null : cachedCommandResult(cacheContext, command, resolutionMs, responseMode);
  const cacheLookupMs = Date.now() - cacheLookupStartedAt;
  if (cached) {
    return withPerformancePhases(cached, {
      resolutionMs,
      cacheLookupMs,
      resultNormalizationMs: 0,
      totalMs: Date.now() - totalStartedAt,
    });
  }

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
  return rememberSuccessfulCommandResult(cacheContext, finalizedResult, args);
}

export async function runProjectCommandAsync(state: AppState, args: Record<string, any>, logger: { stdout: (data: string) => void, stderr: (data: string) => void }, setCancelFn: (fn: () => void) => void): Promise<RunProjectCommandResult> {
  const totalStartedAt = Date.now();
  const resolutionStartedAt = totalStartedAt;
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const resolvedCommand = resolveAllowedCommand(root, command);
  const cwdPath = resolveSafeCommandCwd(root, args.cwd ?? resolvedCommand.cwd);
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : resolvedCommand.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { responseMode, maxOutputBytes } = resolveOutputBudget(args, resolvedCommand);
  const resolutionMs = Date.now() - resolutionStartedAt;

  const cacheLookupStartedAt = Date.now();
  const cacheContext = commandCacheContext(root, resolvedCommand, cwdPath, timeoutMs, maxOutputBytes, responseMode, args);
  const cached = args.forceFresh === true ? null : cachedCommandResult(cacheContext, command, resolutionMs, responseMode);
  const cacheLookupMs = Date.now() - cacheLookupStartedAt;
  if (cached) {
    return withPerformancePhases(cached, {
      resolutionMs,
      cacheLookupMs,
      resultNormalizationMs: 0,
      totalMs: Date.now() - totalStartedAt,
    });
  }

  const startedAt = Date.now();
  
  return new Promise((resolve, reject) => {
    const spawnStartedAt = Date.now();
    const child = spawn(resolvedCommand.executable, resolvedCommand.args, {
      cwd: cwdPath,
      shell: false,
    });

    let processStartupMs: number | undefined;
    child.once('spawn', () => {
      processStartupMs = Date.now() - spawnStartedAt;
    });

    let timedOut = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    setCancelFn(() => {
      clearTimeout(timeoutId);
      child.kill('SIGTERM');
      reject(new Error('Job cancelled'));
    });

    child.stdout.on('data', (data) => {
      const chunk = data.toString('utf8');
      stdoutBuffer += chunk;
      logger.stdout(chunk);
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString('utf8');
      stderrBuffer += chunk;
      logger.stderr(chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(createApiError(500, 'COMMAND_EXEC_ERROR', `Failed to run '${command}'.`, { details: err.message }));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startedAt;

      const resultNormalizationStartedAt = Date.now();
      const commandResult = buildCommandResult({
        command,
        root,
        cwdPath,
        exitCode: code,
        durationMs,
        timedOut,
        signal,
        stdoutRaw: stdoutBuffer,
        stderrRaw: stderrBuffer,
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
      resolve(rememberSuccessfulCommandResult(cacheContext, finalizedResult, args));
    });
  });
}

