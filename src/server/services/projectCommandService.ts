import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { createApiError } from './api';
import { resolveProjectRoot, resolveSafePath } from './localFileService';

const ALLOWED_COMMANDS = ['typecheck', 'test', 'lint', 'build', 'verify'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 12_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 100_000;

type AllowedCommand = typeof ALLOWED_COMMANDS[number];

export interface RunProjectCommandResult {
  command: AllowedCommand;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function truncateOutput(value: string, maxBytes: number) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) {
    return { value, truncated: false };
  }

  return {
    value: `${Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[truncated]`,
    truncated: true,
  };
}

function resolveCommandLabel(value: unknown): AllowedCommand {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if ((ALLOWED_COMMANDS as readonly string[]).includes(normalized)) {
    return normalized as AllowedCommand;
  }

  throw createApiError(
    400,
    'COMMAND_NOT_ALLOWED',
    `Command '${normalized || String(value || '')}' is not in the verification allowlist.`,
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
  if (!fs.existsSync(packageJsonPath)) {
    throw createApiError(400, 'PACKAGE_JSON_NOT_FOUND', 'package.json was not found in the selected project root.');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    throw createApiError(400, 'INVALID_PACKAGE_JSON', 'package.json could not be parsed.', {
      details: error instanceof Error ? error.message : String(error),
    });
  }

  return parsed?.scripts && typeof parsed.scripts === 'object' ? parsed.scripts as Record<string, string> : {};
}

function resolveAllowedCommand(root: string, command: AllowedCommand) {
  const scripts = readPackageScripts(root);
  if (!scripts[command]) {
    throw createApiError(400, 'COMMAND_NOT_CONFIGURED', `Allowed command '${command}' is not configured in package.json scripts.`, {
      affectedId: command,
    });
  }

  return {
    command,
    executable: process.platform === 'win32' ? process.execPath : 'npm',
    args: process.platform === 'win32'
      ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'run', command]
      : ['run', command],
  };
}

export function runProjectCommand(state: AppState, args: Record<string, any>): RunProjectCommandResult {
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const cwdPath = resolveSafeCommandCwd(root, args.cwd);
  const resolvedCommand = resolveAllowedCommand(root, command);
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = Number.isFinite(Number(args.maxOutputBytes))
    ? Math.max(1, Math.min(MAX_OUTPUT_BYTES, Number(args.maxOutputBytes)))
    : DEFAULT_MAX_OUTPUT_BYTES;

  const startedAt = Date.now();
  const result = spawnSync(resolvedCommand.executable, resolvedCommand.args, {
    cwd: cwdPath,
    shell: false,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: Math.max(maxOutputBytes * 4, 1_000_000),
  });
  const durationMs = Date.now() - startedAt;
  const stdout = truncateOutput(result.stdout || '', maxOutputBytes);
  const stderr = truncateOutput(result.stderr || '', maxOutputBytes);
  const timedOut = Boolean(result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT');

  if (result.error && !timedOut) {
    throw createApiError(500, 'COMMAND_EXEC_ERROR', `Failed to run '${command}'.`, {
      details: result.error.message,
    });
  }

  return {
    command,
    cwd: path.relative(root, cwdPath) || '.',
    exitCode: result.status,
    durationMs,
    timedOut,
    signal: result.signal,
    stdout: stdout.value,
    stderr: stderr.value,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

export async function runProjectCommandAsync(state: AppState, args: Record<string, any>, logger: { stdout: (data: string) => void, stderr: (data: string) => void }, setCancelFn: (fn: () => void) => void): Promise<RunProjectCommandResult> {
  const root = resolveProjectRoot(state, args);
  const command = resolveCommandLabel(args.command ?? args.preset);
  const cwdPath = resolveSafeCommandCwd(root, args.cwd);
  const resolvedCommand = resolveAllowedCommand(root, command);
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(args.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = Number.isFinite(Number(args.maxOutputBytes))
    ? Math.max(1, Math.min(MAX_OUTPUT_BYTES, Number(args.maxOutputBytes)))
    : DEFAULT_MAX_OUTPUT_BYTES;

  const startedAt = Date.now();
  
  return new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand.executable, resolvedCommand.args, {
      cwd: cwdPath,
      shell: false,
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
      if (stdoutBuffer.length < maxOutputBytes) {
        stdoutBuffer += chunk;
      }
      logger.stdout(chunk);
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString('utf8');
      if (stderrBuffer.length < maxOutputBytes) {
        stderrBuffer += chunk;
      }
      logger.stderr(chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(createApiError(500, 'COMMAND_EXEC_ERROR', `Failed to run '${command}'.`, { details: err.message }));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startedAt;
      const stdout = truncateOutput(stdoutBuffer, maxOutputBytes);
      const stderr = truncateOutput(stderrBuffer, maxOutputBytes);

      resolve({
        command,
        cwd: path.relative(root, cwdPath) || '.',
        exitCode: code,
        durationMs,
        timedOut,
        signal,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}

