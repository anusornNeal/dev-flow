import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type SupportedPlatform = NodeJS.Platform;

export type RuntimeCpuTimes = {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
};

export type SystemResourceSnapshot = {
  capturedAt: number;
  cpuIdleMs: number;
  cpuTotalMs: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
};

export type ProcessTreeResourceSample = {
  supported: boolean;
  treeAccounting: boolean;
  memoryAccounting: 'complete' | 'partial' | 'unknown';
  processCount?: number;
  rssBytes?: number;
  cpuRatio?: number;
  reason?: 'sampler-failed' | 'unsupported-platform' | 'process-not-found';
  partialReason?: 'descendant-enumeration-failed';
};

export type ProcessTreeTerminationResult = {
  attempted: boolean;
  treeTermination: boolean;
  terminated: boolean;
  reason?: 'invalid-pid' | 'unsupported-platform' | 'terminator-failed';
};

type ResourceCommandResult = {
  status: number | null;
  stdout: string;
  stderr?: string;
};

type ResourceCommandRunner = (executable: string, args: string[]) => ResourceCommandResult;

function clampRatio(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 1_000_000) / 1_000_000));
}

function defaultResourceCommandRunner(executable: string, args: string[]): ResourceCommandResult {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 1_500,
    maxBuffer: 1_000_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

export function normalizeLocalPathIdentity(value: unknown, platform: SupportedPlatform = process.platform) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const looksWindows = /^[a-zA-Z]:[\\/]/.test(raw) || raw.includes('\\');
  const resolved = looksWindows ? path.win32.resolve(raw) : path.posix.resolve(raw);
  const normalized = resolved.replace(/\\/g, '/').replace(/\/+$/g, '');
  return platform === 'win32' && looksWindows ? normalized.toLowerCase() : normalized;
}

export function resolvePackageManagerInvocation(
  command: 'npm' | 'npx',
  args: string[],
  options: {
    platform?: SupportedPlatform;
    execPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const explicitCli = String(command === 'npm' ? env.npm_execpath || '' : env.npx_execpath || '').trim();
  if (explicitCli) return { executable: execPath, args: [explicitCli, ...args], shell: false as const };
  if (platform === 'win32') {
    const cliName = command === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
    return {
      executable: execPath,
      args: [path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', cliName), ...args],
      shell: false as const,
    };
  }
  return { executable: command, args: [...args], shell: false as const };
}

export function normalizeRepoRelativePath(root: string, absolutePath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(absolutePath));
  return relative.replace(/\\/g, '/') || '.';
}

export function getMachineRuntimeProfile(options: {
  platform?: SupportedPlatform;
  arch?: string;
  runtimeVersion?: string;
  cpuModels?: string[];
  totalMemoryBytes?: number;
} = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runtimeVersion = options.runtimeVersion ?? process.version;
  const cpuModels = options.cpuModels ?? os.cpus().map((cpu) => cpu.model || 'unknown');
  const cpuCount = Math.max(1, cpuModels.length || os.cpus().length || 1);
  const normalizedModels = [...new Set(cpuModels.map((model) => String(model || 'unknown').trim().toLowerCase()))].sort();
  const cpuModelHash = crypto.createHash('sha256').update(JSON.stringify(normalizedModels)).digest('hex').slice(0, 16);
  const totalMemoryBytes = Math.max(0, Number(options.totalMemoryBytes ?? os.totalmem()) || 0);
  const gib = 1024 ** 3;
  const totalMemoryBytesBucket = Math.max(gib, Math.round(totalMemoryBytes / gib) * gib);
  const runtimeMajor = Number.parseInt(String(runtimeVersion).replace(/^v/, '').split('.')[0] || '0', 10) || 0;
  const identity = { platform, arch, runtimeMajor, cpuCount, cpuModelHash, totalMemoryBytesBucket };
  const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
  return { key, ...identity };
}

export function captureSystemResourceSnapshot(options: {
  now?: number;
  cpuTimes?: RuntimeCpuTimes[];
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
} = {}): SystemResourceSnapshot {
  const cpuTimes = options.cpuTimes ?? os.cpus().map((cpu) => cpu.times);
  let cpuIdleMs = 0;
  let cpuTotalMs = 0;
  for (const times of cpuTimes) {
    const user = Number(times.user) || 0;
    const nice = Number(times.nice) || 0;
    const sys = Number(times.sys) || 0;
    const idle = Number(times.idle) || 0;
    const irq = Number(times.irq) || 0;
    cpuIdleMs += idle;
    cpuTotalMs += user + nice + sys + idle + irq;
  }
  return {
    capturedAt: options.now ?? Date.now(),
    cpuIdleMs,
    cpuTotalMs,
    totalMemoryBytes: Math.max(0, Number(options.totalMemoryBytes ?? os.totalmem()) || 0),
    freeMemoryBytes: Math.max(0, Number(options.freeMemoryBytes ?? os.freemem()) || 0),
  };
}

export function diffSystemResourceSnapshots(start: SystemResourceSnapshot, end: SystemResourceSnapshot) {
  const totalDelta = Math.max(0, end.cpuTotalMs - start.cpuTotalMs);
  const idleDelta = Math.max(0, end.cpuIdleMs - start.cpuIdleMs);
  const cpuUtilization = totalDelta > 0 ? clampRatio(1 - idleDelta / totalDelta) : 0;
  const memoryPressure = (snapshot: SystemResourceSnapshot) => snapshot.totalMemoryBytes > 0
    ? clampRatio(1 - snapshot.freeMemoryBytes / snapshot.totalMemoryBytes)
    : 0;
  const memoryPressureStart = memoryPressure(start);
  const memoryPressureEnd = memoryPressure(end);
  return {
    durationMs: Math.max(0, end.capturedAt - start.capturedAt),
    cpuUtilization,
    memoryPressureStart,
    memoryPressureEnd,
    peakMemoryPressure: Math.max(memoryPressureStart, memoryPressureEnd),
  };
}

function parsePosixProcessRows(stdout: string) {
  const rows: Array<{ pid: number; ppid: number; rssKb: number; cpuPercent: number }> = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [pid, ppid, rssKb, cpuPercent] = parts.map(Number);
    if (![pid, ppid, rssKb, cpuPercent].every(Number.isFinite)) continue;
    rows.push({ pid, ppid, rssKb, cpuPercent });
  }
  return rows;
}

function collectDescendantPids(rootPid: number, rows: Array<{ pid: number; ppid: number }>) {
  const included = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!included.has(row.pid) && included.has(row.ppid)) {
        included.add(row.pid);
        changed = true;
      }
    }
  }
  return included;
}

function parseWindowsTasklistMemory(stdout: string) {
  if (!stdout || /^INFO:/i.test(stdout.trim())) return undefined;
  const fields = [...stdout.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  const memory = fields.at(-1);
  if (!memory) return undefined;
  const numeric = Number(memory.replace(/[^0-9]/g, ''));
  return Number.isFinite(numeric) ? numeric * 1024 : undefined;
}

function parseCsvFields(line: string) {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(current);
      current = '';
    } else current += char;
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

function parseWindowsProcessRows(stdout: string) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [] as Array<{ pid: number; ppid: number; rssBytes: number }>, complete: false };
  const headers = parseCsvFields(lines[0]).map((field) => field.replace(/^\uFEFF/, '').toLowerCase());
  const pidIndex = headers.indexOf('processid');
  const ppidIndex = headers.indexOf('parentprocessid');
  const rssIndex = headers.indexOf('workingsetsize');
  if (pidIndex < 0 || ppidIndex < 0 || rssIndex < 0) return { rows: [], complete: false };
  const rows: Array<{ pid: number; ppid: number; rssBytes: number }> = [];
  let complete = true;
  for (const line of lines.slice(1)) {
    const fields = parseCsvFields(line);
    const pid = Number(fields[pidIndex]);
    const ppid = Number(fields[ppidIndex]);
    const rssBytes = Number(fields[rssIndex]);
    if (![pid, ppid, rssBytes].every(Number.isFinite)) {
      complete = false;
      continue;
    }
    rows.push({ pid, ppid, rssBytes: Math.max(0, rssBytes) });
  }
  return { rows, complete };
}

export function terminateProcessTree(pid: number, options: {
  platform?: SupportedPlatform;
  run?: ResourceCommandRunner;
} = {}): ProcessTreeTerminationResult {
  const rootPid = Math.floor(Number(pid));
  if (!Number.isFinite(rootPid) || rootPid <= 0) return { attempted: false, treeTermination: false, terminated: false, reason: 'invalid-pid' };
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { attempted: false, treeTermination: false, terminated: false, reason: 'unsupported-platform' };
  const result = (options.run ?? defaultResourceCommandRunner)('taskkill', ['/PID', String(rootPid), '/T', '/F']);
  return result.status === 0
    ? { attempted: true, treeTermination: true, terminated: true }
    : { attempted: true, treeTermination: true, terminated: false, reason: 'terminator-failed' };
}

export function sampleProcessTreeResources(pid: number, options: {
  platform?: SupportedPlatform;
  cpuCount?: number;
  run?: ResourceCommandRunner;
} = {}): ProcessTreeResourceSample {
  const rootPid = Math.floor(Number(pid));
  if (!Number.isFinite(rootPid) || rootPid <= 0) return { supported: false, treeAccounting: false, memoryAccounting: 'unknown', reason: 'process-not-found' };
  const platform = options.platform ?? process.platform;
  const cpuCount = Math.max(1, Math.floor(Number(options.cpuCount) || os.cpus().length || 1));
  const run = options.run ?? defaultResourceCommandRunner;

  if (platform === 'darwin' || platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    const result = run('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=']);
    if (result.status !== 0) return { supported: false, treeAccounting: false, memoryAccounting: 'unknown', reason: 'sampler-failed' };
    const rows = parsePosixProcessRows(result.stdout);
    if (!rows.some((row) => row.pid === rootPid)) return { supported: false, treeAccounting: true, memoryAccounting: 'complete', reason: 'process-not-found' };
    const included = collectDescendantPids(rootPid, rows);
    const matched = rows.filter((row) => included.has(row.pid));
    const rssBytes = matched.reduce((sum, row) => sum + Math.max(0, row.rssKb), 0) * 1024;
    const cpuPercent = matched.reduce((sum, row) => sum + Math.max(0, row.cpuPercent), 0);
    return {
      supported: true,
      treeAccounting: true,
      memoryAccounting: 'complete',
      processCount: matched.length,
      rssBytes,
      cpuRatio: clampRatio(cpuPercent / (100 * cpuCount)),
    };
  }

  if (platform === 'win32') {
    const processTable = run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Csv -NoTypeInformation',
    ]);
    if (processTable.status === 0) {
      const parsed = parseWindowsProcessRows(processTable.stdout);
      const rows = parsed.rows;
      if (parsed.complete && rows.some((row) => row.pid === rootPid)) {
        const included = collectDescendantPids(rootPid, rows);
        const matched = rows.filter((row) => included.has(row.pid));
        return {
          supported: true,
          treeAccounting: true,
          memoryAccounting: 'complete',
          processCount: matched.length,
          rssBytes: matched.reduce((sum, row) => sum + row.rssBytes, 0),
        };
      }
    }

    const fallback = run('tasklist', ['/FI', `PID eq ${rootPid}`, '/FO', 'CSV', '/NH']);
    if (fallback.status !== 0) return { supported: false, treeAccounting: false, memoryAccounting: 'unknown', reason: 'sampler-failed' };
    const rssBytes = parseWindowsTasklistMemory(fallback.stdout);
    if (rssBytes === undefined) return { supported: false, treeAccounting: false, memoryAccounting: 'unknown', reason: 'process-not-found' };
    return {
      supported: true,
      treeAccounting: false,
      memoryAccounting: 'partial',
      partialReason: 'descendant-enumeration-failed',
      processCount: 1,
      rssBytes,
    };
  }

  return { supported: false, treeAccounting: false, memoryAccounting: 'unknown', reason: 'unsupported-platform' };
}
