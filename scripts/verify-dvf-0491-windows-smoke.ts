import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'));
const supervisorArgs = ['--import', 'tsx', 'scripts/start-all.ts', '--server-only'];

type CapturedChild = {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
};

function captureSupervisor(env: NodeJS.ProcessEnv): CapturedChild {
  const child = spawn(process.execPath, supervisorArgs, {
    cwd: repoRoot,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitFor<T>(read: () => T | undefined | null | false, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function isPortOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForPort(port: number, expectedOpen: boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port) === expectedOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for port ${port} to become ${expectedOpen ? 'open' : 'closed'}.`);
}

function readJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

function removeTempRoot(root: string) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[dvf-0491-smoke] cleanup warning for ${root}: ${message}`);
  }
}

async function waitForExit(captured: CapturedChild, timeoutMs: number) {
  if (captured.child.exitCode !== null) return captured.child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      captured.child.kill();
      reject(new Error(`Process did not exit within ${timeoutMs}ms. stdout=${captured.stdout()} stderr=${captured.stderr()}`));
    }, timeoutMs);
    captured.child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function requestOwnerShutdown(ownerPath: string) {
  const owner = readJson(ownerPath);
  if (!owner?.controlPort || !owner?.controlToken) return false;
  const response = await fetch(`http://127.0.0.1:${owner.controlPort}/shutdown`, {
    method: 'POST',
    headers: { 'x-devflow-runtime-token': owner.controlToken },
  }).catch(() => null);
  return response?.status === 202;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[dvf-0491-smoke] skipped: Windows-only lifecycle smoke');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dvf-0491-smoke-'));
  const runtimeDir = path.join(tempRoot, '.devflow');
  const ownerPath = path.join(runtimeDir, 'runtime-owner', 'owner.json');
  const supervisorStatePath = path.join(runtimeDir, 'supervisor-state.json');
  const restartStatePath = path.join(tempRoot, '.devflow', 'restart-state.json');
  const port = await getFreePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVFLOW_APP_ROOT: tempRoot,
    DEVFLOW_RUNTIME_DIR: runtimeDir,
    DEVFLOW_DB_PATH: path.join(tempRoot, 'devflow.db'),
    DEVFLOW_JOBS_DIR: path.join(tempRoot, 'jobs'),
    DEVFLOW_PORT: String(port),
    PORT: String(port),
    DEVFLOW_OPEN_BROWSER: 'false',
  };

  let primary: CapturedChild | null = null;
  let replacementPrimary: CapturedChild | null = null;
  try {
    primary = captureSupervisor(env);
    const firstOwner = await waitFor(() => readJson(ownerPath), 10_000, 'first runtime owner');
    await waitForPort(port, true, 25_000);
    const firstState = await waitFor(() => {
      const state = readJson(supervisorStatePath);
      return state?.processes?.server?.pid ? state : null;
    }, 10_000, 'first server PID');
    const firstServerPid = Number(firstState.processes.server.pid);
    assert.equal(Number(firstOwner.pid), primary.child.pid);

    const duplicateRuns = await Promise.all(Array.from({ length: 5 }, async () => {
      const duplicate = captureSupervisor(env);
      const exitCode = await waitForExit(duplicate, 10_000);
      assert.equal(exitCode, 0, duplicate.stderr() || duplicate.stdout());
      assert.match(duplicate.stdout(), /Reusing healthy DevFlow runtime/);
      return duplicate;
    }));
    assert.equal(duplicateRuns.length, 5);
    const afterDuplicates = readJson(ownerPath);
    const stateAfterDuplicates = readJson(supervisorStatePath);
    assert.equal(afterDuplicates?.instanceId, firstOwner.instanceId);
    assert.equal(Number(afterDuplicates?.pid), primary.child.pid);
    assert.equal(Number(stateAfterDuplicates?.processes?.server?.pid), firstServerPid);

    const restartResponse = await fetch(`http://127.0.0.1:${port}/api/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const restartBody = await restartResponse.json() as Record<string, any>;
    assert.equal(restartResponse.status, 200, JSON.stringify(restartBody));
    assert.equal(restartBody.accepted, true);
    const restartTicket = String(restartBody.ticket || '');
    assert.match(restartTicket, /^restart-/);

    const restartedState = await waitFor(() => {
      const state = readJson(supervisorStatePath);
      const pid = Number(state?.processes?.server?.pid || 0);
      return pid > 0 && pid !== firstServerPid ? state : null;
    }, 20_000, 'replacement server PID');
    const replacementServerPid = Number(restartedState.processes.server.pid);
    await waitFor(() => {
      const state = readJson(restartStatePath);
      return state?.ticket === restartTicket && state?.status === 'healthy' ? state : null;
    }, 20_000, 'healthy restart ticket');
    const ownerAfterRestart = readJson(ownerPath);
    assert.equal(ownerAfterRestart?.instanceId, firstOwner.instanceId);
    assert.equal(Number(ownerAfterRestart?.pid), primary.child.pid);

    assert.equal(await requestOwnerShutdown(ownerPath), true);
    assert.equal(await waitForExit(primary, 10_000), 0, primary.stderr() || primary.stdout());
    await waitForPort(port, false, 10_000);
    assert.equal(fs.existsSync(ownerPath), false);

    replacementPrimary = captureSupervisor(env);
    const secondOwner = await waitFor(() => readJson(ownerPath), 10_000, 'second runtime owner');
    await waitForPort(port, true, 25_000);
    assert.notEqual(secondOwner.instanceId, firstOwner.instanceId);
    assert.equal(Number(secondOwner.pid), replacementPrimary.child.pid);
    assert.equal(await requestOwnerShutdown(ownerPath), true);
    assert.equal(await waitForExit(replacementPrimary, 10_000), 0, replacementPrimary.stderr() || replacementPrimary.stdout());
    await waitForPort(port, false, 10_000);

    const foreignPort = await getFreePort();
    const foreignServer = net.createServer();
    await new Promise<void>((resolve, reject) => {
      foreignServer.once('error', reject);
      foreignServer.listen(foreignPort, '127.0.0.1', () => resolve());
    });
    const conflictRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dvf-0491-conflict-'));
    const conflictEnv = {
      ...env,
      DEVFLOW_APP_ROOT: conflictRoot,
      DEVFLOW_RUNTIME_DIR: path.join(conflictRoot, '.devflow'),
      DEVFLOW_DB_PATH: path.join(conflictRoot, 'devflow.db'),
      DEVFLOW_JOBS_DIR: path.join(conflictRoot, 'jobs'),
      DEVFLOW_PORT: String(foreignPort),
      PORT: String(foreignPort),
    };
    try {
      const conflict = captureSupervisor(conflictEnv);
      const conflictExit = await waitForExit(conflict, 10_000);
      assert.equal(conflictExit, 1);
      assert.match(`${conflict.stdout()}\n${conflict.stderr()}`, /already occupied|No process was terminated/i);
      assert.equal(foreignServer.listening, true);
    } finally {
      await new Promise<void>((resolve, reject) => foreignServer.close((error) => error ? reject(error) : resolve()));
      removeTempRoot(conflictRoot);
    }

    console.log(JSON.stringify({
      ok: true,
      supervisorPid: firstOwner.pid,
      firstServerPid,
      replacementServerPid,
      duplicateLaunches: 5,
      restartTicket,
      secondSupervisorPid: secondOwner.pid,
      portConflictPreserved: true,
    }));
  } finally {
    if (primary && primary.child.exitCode === null) {
      await requestOwnerShutdown(ownerPath).catch(() => false);
      await waitForExit(primary, 5_000).catch(() => primary?.child.kill());
    }
    if (replacementPrimary && replacementPrimary.child.exitCode === null) {
      await requestOwnerShutdown(ownerPath).catch(() => false);
      await waitForExit(replacementPrimary, 5_000).catch(() => replacementPrimary?.child.kill());
    }
    removeTempRoot(tempRoot);
  }
}

await main();
