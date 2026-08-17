import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDevFlowRuntimeDir } from '../src/lib/devFlowPaths.js';

const AGENT_PORT_START = 8888;
const AGENT_PORT_END = 8988;
const AGENT_READY_TIMEOUT_MS = 12_000;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_SELECTION_BYTES = 4_096;
const MAX_RESERVED_NAME_LENGTH = 256;

type BootstrapResult = {
  ok: boolean;
  code: string;
  message: string;
  zrokPath?: string;
  serviceName: 'zrokAgent';
  reservedName?: string;
  remoteControl?: 'available' | 'unsupported';
  changed: string[];
};

type NameRecord = {
  name: string;
  namespaceToken: string;
  reserved: boolean;
};

class BootstrapError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function command(binary: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxBuffer: 2_000_000,
    env: options.env || process.env,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error as NodeJS.ErrnoException | undefined,
  };
}

function findOnPath(name: string) {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return '';
}

export function resolveMacZrokExecutable(runtimeDir = getDevFlowRuntimeDir()) {
  const explicit = String(process.env.DEVFLOW_ZROK_BIN || process.env.DEVFLOW_ZROK_EXE || '').trim();
  if (explicit) {
    try {
      fs.accessSync(explicit, fs.constants.X_OK);
      return path.resolve(explicit);
    } catch {}
  }
  const fromPath = findOnPath('zrok2');
  if (fromPath) return fromPath;
  const local = path.join(runtimeDir, 'bin', 'zrok2');
  try {
    fs.accessSync(local, fs.constants.X_OK);
    return local;
  } catch {
    return '';
  }
}

function releaseArchitecture() {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'amd64';
  throw new BootstrapError('unsupported-architecture', `Unsupported macOS architecture: ${process.arch}.`);
}

async function downloadFile(url: string, destination: string) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'DevFlow-zrok-bootstrap' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) throw new BootstrapError('download-failed', `Unable to download zrok2 (HTTP ${response.status}).`);
  const file = fs.createWriteStream(destination, { mode: 0o600 });
  try {
    for await (const chunk of response.body as any) file.write(chunk);
  } finally {
    await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => error ? reject(error) : resolve()));
  }
}

function sha256(filePath: string) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function findFileRecursive(root: string, name: string): string {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = findFileRecursive(candidate, name);
      if (nested) return nested;
    }
  }
  return '';
}

export async function installMacZrok(runtimeDir = getDevFlowRuntimeDir()) {
  const releaseResponse = await fetch('https://api.github.com/repos/openziti/zrok/releases/latest', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'DevFlow-zrok-bootstrap' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!releaseResponse.ok) throw new BootstrapError('download-failed', `Unable to inspect the latest zrok release (HTTP ${releaseResponse.status}).`);
  const release = await releaseResponse.json() as { assets?: Array<{ name?: string; browser_download_url?: string; digest?: string }> };
  const arch = releaseArchitecture();
  const assetPattern = new RegExp(`^zrok_[0-9.]+_darwin_${arch}\\.tar\\.gz$`);
  const asset = (release.assets || []).find((candidate) => assetPattern.test(String(candidate.name || '')));
  if (!asset?.browser_download_url || !asset.name) {
    throw new BootstrapError('download-failed', `Latest zrok release does not contain a macOS ${arch} archive.`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-zrok-'));
  try {
    const archivePath = path.join(tempDir, asset.name);
    await downloadFile(asset.browser_download_url, archivePath);
    const digest = String(asset.digest || '').trim().toLowerCase();
    if (digest.startsWith('sha256:') && sha256(archivePath) !== digest.slice(7)) {
      throw new BootstrapError('download-integrity-failed', 'Downloaded zrok archive failed SHA-256 verification.');
    }
    const extractedDir = path.join(tempDir, 'extracted');
    fs.mkdirSync(extractedDir, { recursive: true });
    const extract = command('/usr/bin/tar', ['-xzf', archivePath, '-C', extractedDir], { timeoutMs: 30_000 });
    if (!extract.ok) throw new BootstrapError('install-failed', 'Unable to extract the macOS zrok archive.');
    const source = findFileRecursive(extractedDir, 'zrok2');
    if (!source) throw new BootstrapError('install-failed', 'zrok2 was not found in the downloaded archive.');
    const binDir = path.join(runtimeDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const destination = path.join(binDir, 'zrok2');
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o755);
    return destination;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseJsonOutput(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const objectIndex = trimmed.indexOf('{');
    const arrayIndex = trimmed.indexOf('[');
    const index = [objectIndex, arrayIndex].filter((value) => value >= 0).sort((a, b) => a - b)[0];
    if (index !== undefined) return JSON.parse(trimmed.slice(index));
    throw new BootstrapError('invalid-json', 'zrok2 returned malformed JSON.');
  }
}

function readSavedReservedName(selectionPath: string) {
  try {
    const stat = fs.statSync(selectionPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SELECTION_BYTES) return '';
    const payload = JSON.parse(fs.readFileSync(selectionPath, 'utf8')) as Record<string, unknown>;
    return validReservedName(payload.reservedName) ? String(payload.reservedName).trim() : '';
  } catch {
    return '';
  }
}

function validReservedName(value: unknown) {
  const name = String(value || '').trim();
  return Boolean(name && name.length <= MAX_RESERVED_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(name));
}

function saveReservedName(selectionPath: string, reservedName: string) {
  fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
  const temp = `${selectionPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ reservedName })}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, selectionPath);
}

function listReservedNames(zrokPath: string): NameRecord[] {
  const result = command(zrokPath, ['list', 'names', '--json']);
  if (!result.ok) throw new BootstrapError('list-names-failed', 'Unable to list zrok reserved names for this account.');
  const parsed = parseJsonOutput(result.stdout);
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.names) ? parsed.names : [];
  return entries.flatMap((entry: any) => {
    const name = String(entry?.name || entry?.Name || '').trim();
    const namespaceToken = String(entry?.namespaceToken || entry?.namespace_token || entry?.NamespaceToken || '').trim();
    const reserved = Boolean(entry?.reserved ?? entry?.Reserved);
    return name && namespaceToken ? [{ name, namespaceToken, reserved }] : [];
  });
}

function defaultReservedName() {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return `devflow-${host || 'mac'}`;
}

function ensureReservedName(zrokPath: string, explicit: string, selectionPath: string, changed: string[]) {
  const names = listReservedNames(zrokPath).filter((entry) => entry.reserved && entry.namespaceToken === 'public');
  let selected = validReservedName(explicit) ? explicit.trim() : readSavedReservedName(selectionPath);
  if (!selected && names.length) selected = names[0].name;
  if (!selected) selected = defaultReservedName();
  const existing = names.find((entry) => entry.name === selected);
  if (!existing) {
    const create = command(zrokPath, ['create', 'name', selected, '--namespace-token', 'public']);
    if (!create.ok) throw new BootstrapError('reserved-name-create-failed', `Unable to create the zrok public name '${selected}'.`);
    changed.push('reserved-name-created');
  }
  saveReservedName(selectionPath, selected);
  return selected;
}

function readSecret(prompt: string): Promise<string> {
  const preset = String(process.env.DEVFLOW_ZROK_ACCOUNT_TOKEN || process.env.ZROK2_ENABLE_TOKEN || '').trim();
  if (preset) return Promise.resolve(preset);
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') return Promise.resolve('');
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let value = '';
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      process.stdout.write('\n');
      resolve(value.trim());
    };
    const onData = (chunk: string | Buffer) => {
      const text = String(chunk);
      for (const character of text) {
        if (character === '\r' || character === '\n') return done();
        if (character === '\u0003') {
          value = '';
          return done();
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function ensureEnvironment(zrokPath: string, changed: string[]) {
  const environmentPath = path.join(os.homedir(), '.zrok2', 'environment.json');
  try {
    if (fs.statSync(environmentPath).size > 0) return;
  } catch {}
  const token = await readSecret('zrok account token: ');
  if (!token) throw new BootstrapError('token-required', 'A zrok account token is required to enable this macOS environment.');
  const enabled = command(zrokPath, ['enable', token], { timeoutMs: 30_000 });
  if (!enabled.ok) throw new BootstrapError('enable-failed', 'Unable to enable the zrok environment. Check the account token and network connection.');
  changed.push('environment-enabled');
}

function remotingFailureIsUnsupported(output: string) {
  return /\b501\b|unimplemented|not\s+implemented/i.test(output);
}

function ensureRemoting(zrokPath: string, changed: string[]) {
  const enrollmentPath = path.join(os.homedir(), '.zrok2', 'agent-enrollment.json');
  if (fs.existsSync(enrollmentPath)) return 'available' as const;
  const enrolled = command(zrokPath, ['agent', 'enroll', '--headless'], { timeoutMs: 30_000 });
  if (enrolled.ok) {
    changed.push('agent-remoting-enrolled');
    return 'available' as const;
  }
  if (remotingFailureIsUnsupported(`${enrolled.stdout}\n${enrolled.stderr}`)) return 'unsupported' as const;
  throw new BootstrapError('remoting-enroll-failed', 'Unable to enroll the zrok Agent for remote control.');
}

async function agentReachable() {
  for (let port = AGENT_PORT_START; port <= AGENT_PORT_END; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/agent/status`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(120),
      });
      if (response.status === 200) return true;
    } catch {}
  }
  return false;
}

async function ensureAgentRunning(zrokPath: string, runtimeDir: string, changed: string[]) {
  if (await agentReachable()) return;
  fs.mkdirSync(runtimeDir, { recursive: true });
  const logPath = path.join(runtimeDir, 'zrok-agent.log');
  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(zrokPath, ['agent', 'start'], {
      detached: true,
      shell: false,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    child.unref();
    changed.push('agent-started');
  } finally {
    fs.closeSync(fd);
  }
  const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await agentReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new BootstrapError('agent-start-failed', 'zrok Agent did not become reachable after startup.');
}

function localShareExists(zrokPath: string, target: string, reservedName: string) {
  const result = command(zrokPath, ['list', 'shares', '--json']);
  if (!result.ok) return false;
  try {
    const parsed = parseJsonOutput(result.stdout);
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.shares) ? parsed.shares : [];
    return entries.some((entry: any) => {
      const entryTarget = String(entry?.target || entry?.Target || '').replace(/\/+$/, '').toLowerCase();
      const selection = String(entry?.nameSelection || entry?.name_selection || entry?.NameSelection || '').toLowerCase();
      return entryTarget === target.replace(/\/+$/, '').toLowerCase() && (!selection || selection.endsWith(`:${reservedName.toLowerCase()}`));
    });
  } catch {
    return false;
  }
}

function ensureInitialShare(zrokPath: string, target: string, reservedName: string, changed: string[]) {
  if (localShareExists(zrokPath, target, reservedName)) return;
  const share = command(zrokPath, [
    'share', 'public', target,
    '--force-agent',
    '--open',
    '--name-selection', `public:${reservedName}`,
  ], { timeoutMs: 30_000 });
  if (!share.ok) throw new BootstrapError('share-start-failed', 'Unable to start the DevFlow public share through the zrok Agent.');
  changed.push('agent-share-started');
}

function parseArgs(argv: string[]) {
  const reservedIndex = argv.indexOf('--reserved-name');
  const reservedName = reservedIndex >= 0 ? String(argv[reservedIndex + 1] || '').trim() : '';
  return { reservedName };
}

export async function bootstrapMacZrok(input: { reservedName?: string; runtimeDir?: string; target?: string } = {}): Promise<BootstrapResult> {
  const changed: string[] = [];
  const runtimeDir = path.resolve(input.runtimeDir || getDevFlowRuntimeDir());
  const selectionPath = path.join(runtimeDir, 'zrok-selection.json');
  const target = String(input.target || process.env.DEVFLOW_ZROK_TARGET || 'http://127.0.0.1:3000').trim();
  try {
    if (process.platform !== 'darwin') throw new BootstrapError('unsupported-platform', 'This bootstrap is only for macOS.');
    let zrokPath = resolveMacZrokExecutable(runtimeDir);
    if (!zrokPath) {
      zrokPath = await installMacZrok(runtimeDir);
      changed.push('zrok-installed');
    }
    const version = command(zrokPath, ['version']);
    if (!version.ok) throw new BootstrapError('zrok-unavailable', 'zrok2 is installed but could not be executed.');
    await ensureEnvironment(zrokPath, changed);
    const reservedName = ensureReservedName(zrokPath, String(input.reservedName || ''), selectionPath, changed);
    const remoteControl = ensureRemoting(zrokPath, changed);
    await ensureAgentRunning(zrokPath, runtimeDir, changed);
    ensureInitialShare(zrokPath, target, reservedName, changed);
    return {
      ok: true,
      code: 'ready',
      message: 'zrok bootstrap is ready.',
      zrokPath,
      serviceName: 'zrokAgent',
      reservedName,
      remoteControl,
      changed,
    };
  } catch (error) {
    const failure = error instanceof BootstrapError ? error : new BootstrapError('bootstrap-failed', error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      code: failure.code,
      message: failure.message,
      serviceName: 'zrokAgent',
      reservedName: input.reservedName,
      changed,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await bootstrapMacZrok({ reservedName: args.reservedName });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  void main();
}
