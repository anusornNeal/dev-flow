import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawnSync } from 'child_process';
import { getDevFlowAppRoot, getDevFlowUploadsDir, getDevFlowDbPath } from '../src/lib/devFlowPaths';
import db from '../src/db/index';

type CheckResult = {
  label: string;
  ok: boolean;
  detail: string;
};

const rootDir = process.cwd();
const envPath = path.join(rootDir, '.env');
const envExamplePath = path.join(rootDir, '.env.example');
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'devflow.db');
const projectsBackupPath = path.join(rootDir, 'projects.json.bak');

function runCommand(command: string, args: string[]) {
  const executable = process.platform === 'win32' ? 'cmd.exe' : command;
  const finalArgs = process.platform === 'win32' ? ['/c', command, ...args] : args;
  const result = spawnSync(executable, finalArgs, { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

function checkPortAvailable(port: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (error: NodeJS.ErrnoException) => {
      const detail = error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use.`
        : `Port ${port} check failed: ${error.message}`;
      resolve({ label: `Port ${port}`, ok: false, detail });
    });

    server.once('listening', () => {
      server.close(() => {
        resolve({ label: `Port ${port}`, ok: true, detail: `Port ${port} is available.` });
      });
    });

    server.listen(port, '127.0.0.1');
  });
}

async function main() {
  const results: CheckResult[] = [];

  results.push({
    label: 'Node.js',
    ok: true,
    detail: `Detected ${process.version}`,
  });

  const npmVersion = runCommand('npm', ['--version']);
  results.push({
    label: 'npm',
    ok: npmVersion.status === 0,
    detail: npmVersion.status === 0 ? `Detected ${npmVersion.stdout}` : npmVersion.stderr || 'npm was not found',
  });

  results.push({
    label: 'Environment file',
    ok: fs.existsSync(envPath) || fs.existsSync(envExamplePath),
    detail: fs.existsSync(envPath)
      ? '.env is present.'
      : fs.existsSync(envExamplePath)
        ? '.env is missing, but .env.example is available.'
        : 'Neither .env nor .env.example was found.',
  });

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const probePath = path.join(dataDir, '.doctor-write-test');
  try {
    fs.writeFileSync(probePath, `doctor:${Date.now()}${os.EOL}`, 'utf8');
    fs.unlinkSync(probePath);
    results.push({
      label: 'Data directory',
      ok: true,
      detail: `Writable: ${dataDir}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      label: 'Data directory',
      ok: false,
      detail: `Write check failed: ${message}`,
    });
  }

  const dbProbe = runCommand('npx', ['tsx', 'scripts/db-probe.ts']);
  results.push({
    label: 'SQLite initialization',
    ok: dbProbe.status === 0 && dbProbe.stdout.includes('db-ok'),
    detail: dbProbe.status === 0 ? `Database is reachable at ${dbPath}` : dbProbe.stderr || 'SQLite init failed',
  });

  const portResult = await checkPortAvailable(3000);
  results.push(portResult);

  // Required tables check (per DVF-0173)
  const requiredTables = ['projects', 'tasks', 'counters', 'settings', 'skills', 'agent_runs', 'attachments'];
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const present = new Set(rows.map((r) => r.name));
    const missing = requiredTables.filter((t) => !present.has(t));
    results.push({
      label: 'Required SQLite tables',
      ok: missing.length === 0,
      detail: missing.length === 0
        ? `All ${requiredTables.length} required tables present: ${requiredTables.join(', ')}`
        : `Missing tables: ${missing.join(', ')}`,
    });
  } catch (e) {
    results.push({ label: 'Required SQLite tables', ok: false, detail: (e as Error).message });
  }

  // Uploads directory writability
  const uploadsDir = getDevFlowUploadsDir();
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  const uploadsProbe = path.join(uploadsDir, '.doctor-write-test');
  try {
    fs.writeFileSync(uploadsProbe, 'doctor', 'utf8');
    fs.unlinkSync(uploadsProbe);
    results.push({ label: 'Uploads directory', ok: true, detail: `Writable: ${uploadsDir}` });
  } catch (e) {
    results.push({ label: 'Uploads directory', ok: false, detail: `Write check failed: ${(e as Error).message}` });
  }

  // WAL files check
  const dbPathResolved = getDevFlowDbPath();
  const walPath = `${dbPathResolved}-wal`;
  const shmPath = `${dbPathResolved}-shm`;
  results.push({
    label: 'WAL files',
    ok: true,
    detail: `WAL=${fs.existsSync(walPath) ? 'present' : 'absent'} SHM=${fs.existsSync(shmPath) ? 'present' : 'absent'}`,
  });

  // Legacy JSON detection
  const appRoot = getDevFlowAppRoot();
  const legacy = ['tasks.json', 'projects.json', 'counters.json']
    .map((n) => path.join(appRoot, n))
    .filter((p) => fs.existsSync(p));
  if (legacy.length > 0) {
    results.push({
      label: 'Legacy JSON files',
      ok: false,
      detail: `Found: ${legacy.map((p) => path.basename(p)).join(', ')}. Run npm run migrate:json.`,
    });
  } else {
    results.push({ label: 'Legacy JSON files', ok: true, detail: 'No legacy JSON files detected.' });
  }

  if (fs.existsSync(projectsBackupPath)) {
    try {
      const raw = fs.readFileSync(projectsBackupPath, 'utf8');
      const projects = JSON.parse(raw);
      const missingLocalPaths = Array.isArray(projects)
        ? projects.filter((project) => !project.localPath).length
        : 0;
      results.push({
        label: 'Project local paths',
        ok: true,
        detail: missingLocalPaths === 0
          ? 'All backed-up projects have localPath values.'
          : `${missingLocalPaths} project(s) in projects.json.bak do not have localPath configured.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        label: 'Project local paths',
        ok: false,
        detail: `Could not inspect projects.json.bak: ${message}`,
      });
    }
  } else {
    results.push({
      label: 'Project local paths',
      ok: true,
      detail: 'No projects.json.bak found; skip backup inspection.',
    });
  }

  let hasFailure = false;
  for (const result of results) {
    const prefix = result.ok ? 'OK' : 'WARN';
    if (!result.ok) hasFailure = true;
    console.log(`[doctor] ${prefix} ${result.label}: ${result.detail}`);
  }

  if (hasFailure) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[doctor] FAIL Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
