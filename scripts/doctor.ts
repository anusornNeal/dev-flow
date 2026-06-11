import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawnSync } from 'child_process';

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
