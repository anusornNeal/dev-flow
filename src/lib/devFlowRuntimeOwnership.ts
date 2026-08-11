import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDevFlowRuntimeDir } from './devFlowPaths';

export const DEVFLOW_RUNTIME_OWNER_VERSION = 1 as const;
export const DEVFLOW_RUNTIME_OWNER_SUPERVISOR = 'start-all' as const;
export const DEVFLOW_RUNTIME_CONTROL_TOKEN_HEADER = 'x-devflow-runtime-token' as const;
const DEVFLOW_RUNTIME_STARTING_GRACE_MS = 5 * 60 * 1000;
const DEVFLOW_RUNTIME_OWNER_PROBE_ATTEMPTS = 3;
const DEVFLOW_RUNTIME_OWNER_PROBE_RETRY_MS = 100;

export type DevFlowRuntimeOwner = {
  version: typeof DEVFLOW_RUNTIME_OWNER_VERSION;
  supervisor: typeof DEVFLOW_RUNTIME_OWNER_SUPERVISOR;
  instanceId: string;
  pid: number;
  mode: 'all' | 'server-only';
  appUrl: string;
  controlPort: number;
  controlToken: string;
  startedAt: string;
  updatedAt: string;
};

type LifecycleStatus = 'starting' | 'running' | 'stopping' | 'failed';

type AcquireOptions = {
  mode: DevFlowRuntimeOwner['mode'];
  appUrl: string;
  onShutdown?: () => void | Promise<void>;
  getLifecycleStatus?: () => LifecycleStatus;
  pid?: number;
  instanceId?: string;
  controlToken?: string;
};

type OwnerResult = {
  status: 'owner';
  owner: DevFlowRuntimeOwner;
  recoveredStaleOwner: boolean;
  release: () => Promise<void>;
};

type ReusedResult = {
  status: 'reused';
  owner: DevFlowRuntimeOwner;
  recoveredStaleOwner: boolean;
};

export type DevFlowRuntimeOwnershipResult = OwnerResult | ReusedResult;

export function getDevFlowRuntimeOwnershipDir() {
  return path.join(getDevFlowRuntimeDir(), 'runtime-owner');
}

export function getDevFlowRuntimeOwnerPath() {
  return path.join(getDevFlowRuntimeOwnershipDir(), 'owner.json');
}

function isRuntimeOwner(value: unknown): value is DevFlowRuntimeOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Record<string, unknown>;
  return owner.version === DEVFLOW_RUNTIME_OWNER_VERSION
    && owner.supervisor === DEVFLOW_RUNTIME_OWNER_SUPERVISOR
    && typeof owner.instanceId === 'string' && owner.instanceId.length >= 8
    && Number.isInteger(owner.pid) && Number(owner.pid) > 0
    && (owner.mode === 'all' || owner.mode === 'server-only')
    && typeof owner.appUrl === 'string' && owner.appUrl.startsWith('http://localhost:')
    && Number.isInteger(owner.controlPort) && Number(owner.controlPort) > 0
    && typeof owner.controlToken === 'string' && owner.controlToken.length >= 8
    && typeof owner.startedAt === 'string'
    && typeof owner.updatedAt === 'string';
}

export function readDevFlowRuntimeOwner(): DevFlowRuntimeOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDevFlowRuntimeOwnerPath(), 'utf8')) as unknown;
    return isRuntimeOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeOwner(owner: DevFlowRuntimeOwner) {
  const ownerPath = getDevFlowRuntimeOwnerPath();
  const tempPath = `${ownerPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, ownerPath);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startControlServer(input: {
  instanceId: string;
  controlToken: string;
  pid: number;
  onShutdown?: AcquireOptions['onShutdown'];
  getLifecycleStatus?: AcquireOptions['getLifecycleStatus'];
}) {
  const server = http.createServer((request, response) => {
    const token = String(request.headers[DEVFLOW_RUNTIME_CONTROL_TOKEN_HEADER] || '');
    if (token !== input.controlToken) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    if (request.method === 'GET' && request.url === '/identity') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        supervisor: DEVFLOW_RUNTIME_OWNER_SUPERVISOR,
        instanceId: input.instanceId,
        pid: input.pid,
        lifecycleStatus: input.getLifecycleStatus?.() || 'running',
      }));
      return;
    }

    if (request.method === 'POST' && request.url === '/shutdown') {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: true, instanceId: input.instanceId }));
      queueMicrotask(() => void input.onShutdown?.());
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not-found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('DevFlow runtime control server did not expose a TCP port.');
  }
  return { server, port: address.port };
}

async function closeServer(server: http.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function probeOwner(owner: DevFlowRuntimeOwner) {
  return new Promise<boolean>((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port: owner.controlPort,
      path: '/identity',
      method: 'GET',
      timeout: 500,
      headers: { [DEVFLOW_RUNTIME_CONTROL_TOKEN_HEADER]: owner.controlToken },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve(false);
        try {
          const identity = JSON.parse(body) as Record<string, unknown>;
          const lifecycleStatus = identity.lifecycleStatus;
          const startingAgeMs = Date.now() - Date.parse(owner.startedAt);
          const lifecycleValid = lifecycleStatus === 'running'
            || (lifecycleStatus === 'starting' && Number.isFinite(startingAgeMs) && startingAgeMs <= DEVFLOW_RUNTIME_STARTING_GRACE_MS);
          resolve(
            identity.supervisor === DEVFLOW_RUNTIME_OWNER_SUPERVISOR
            && identity.instanceId === owner.instanceId
            && identity.pid === owner.pid
            && lifecycleValid,
          );
        } catch {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function probeOwnerWithGrace(owner: DevFlowRuntimeOwner) {
  for (let attempt = 0; attempt < DEVFLOW_RUNTIME_OWNER_PROBE_ATTEMPTS; attempt += 1) {
    if (await probeOwner(owner)) return true;
    if (attempt + 1 < DEVFLOW_RUNTIME_OWNER_PROBE_ATTEMPTS) await sleep(DEVFLOW_RUNTIME_OWNER_PROBE_RETRY_MS);
  }
  return false;
}

async function readOwnerWithShortGrace() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const owner = readDevFlowRuntimeOwner();
    if (owner) return owner;
    await sleep(20);
  }
  return null;
}

function quarantineStaleOwnership() {
  const ownershipDir = getDevFlowRuntimeOwnershipDir();
  const staleDir = `${ownershipDir}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(ownershipDir, staleDir);
    fs.rmSync(staleDir, { recursive: true, force: true });
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') return false;
    throw error;
  }
}

export async function acquireDevFlowRuntimeOwnership(options: AcquireOptions): Promise<DevFlowRuntimeOwnershipResult> {
  const runtimeDir = getDevFlowRuntimeDir();
  const ownershipDir = getDevFlowRuntimeOwnershipDir();
  fs.mkdirSync(runtimeDir, { recursive: true });

  const instanceId = options.instanceId || randomUUID();
  const controlToken = options.controlToken || randomUUID();
  const pid = options.pid || process.pid;
  const control = await startControlServer({
    instanceId,
    controlToken,
    pid,
    onShutdown: options.onShutdown,
    getLifecycleStatus: options.getLifecycleStatus,
  });
  let recoveredStaleOwner = false;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.mkdirSync(ownershipDir);
      const now = new Date().toISOString();
      const owner: DevFlowRuntimeOwner = {
        version: DEVFLOW_RUNTIME_OWNER_VERSION,
        supervisor: DEVFLOW_RUNTIME_OWNER_SUPERVISOR,
        instanceId,
        pid,
        mode: options.mode,
        appUrl: options.appUrl,
        controlPort: control.port,
        controlToken,
        startedAt: now,
        updatedAt: now,
      };
      writeOwner(owner);
      return {
        status: 'owner',
        owner,
        recoveredStaleOwner,
        release: async () => {
          await closeServer(control.server);
          const current = readDevFlowRuntimeOwner();
          if (current?.instanceId === owner.instanceId && current.controlToken === owner.controlToken) {
            fs.rmSync(ownershipDir, { recursive: true, force: true });
          }
        },
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        await closeServer(control.server);
        throw error;
      }
    }

    const current = await readOwnerWithShortGrace();
    if (current && await probeOwnerWithGrace(current)) {
      await closeServer(control.server);
      return { status: 'reused', owner: current, recoveredStaleOwner };
    }

    if (quarantineStaleOwnership()) {
      recoveredStaleOwner = true;
      continue;
    }
    await sleep(25);
  }

  await closeServer(control.server);
  throw new Error('Unable to establish authoritative DevFlow runtime ownership after concurrent launch attempts.');
}

export async function assertDevFlowRuntimePortAvailable(port: number, host = '127.0.0.1') {
  const occupied = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(400);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

  if (!occupied) return;
  const error = new Error(`DevFlow cannot start because ${host}:${port} is already occupied by another process. No process was terminated.`) as Error & { code?: string };
  error.code = 'DEVFLOW_PORT_CONFLICT';
  throw error;
}
