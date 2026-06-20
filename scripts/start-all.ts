import 'dotenv/config';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

type StartAllOptions = {
  port: number;
  ngrokDomain: string;
  openBrowser: boolean;
  openBrowserDelayMs: number;
};

type ManagedProcess = {
  label: string;
  command: string;
  args: string[];
};

type StartAllPlan = {
  appUrl: string;
  openBrowser: boolean;
  openBrowserDelayMs: number;
  processes: ManagedProcess[];
};

const DEFAULT_PORT = 3000;
const DEFAULT_BROWSER_DELAY_MS = 4000;

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function executableFor(command: string) {
  return process.platform === 'win32' ? `${command}.cmd` : command;
}

export function buildNgrokArgs({ port, domain }: { port: number; domain: string }) {
  const args = ['http'];
  if (domain.trim()) {
    args.push(`--domain=${domain.trim()}`);
  }
  args.push(String(port));
  return args;
}

export function resolveStartAllOptions(env: NodeJS.ProcessEnv = process.env): StartAllOptions {
  return {
    port: parsePositiveInteger(env.DEVFLOW_PORT || env.PORT, DEFAULT_PORT),
    ngrokDomain: (env.DEVFLOW_NGROK_DOMAIN || '').trim(),
    openBrowser: parseBoolean(env.DEVFLOW_OPEN_BROWSER, true),
    openBrowserDelayMs: parsePositiveInteger(env.DEVFLOW_OPEN_BROWSER_DELAY_MS, DEFAULT_BROWSER_DELAY_MS),
  };
}

export function buildStartAllPlan(options: StartAllOptions): StartAllPlan {
  return {
    appUrl: `http://localhost:${options.port}`,
    openBrowser: options.openBrowser,
    openBrowserDelayMs: options.openBrowserDelayMs,
    processes: [
      { label: 'server', command: executableFor('npm'), args: ['run', 'dev'] },
      { label: 'ngrok', command: executableFor('ngrok'), args: buildNgrokArgs({ port: options.port, domain: options.ngrokDomain }) },
    ],
  };
}

function openUrl(url: string) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function runSetup() {
  console.log('[start-all] Running setup...');
  const result = spawnSync(executableFor('npm'), ['run', 'setup'], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function startProcess(processConfig: ManagedProcess): ChildProcessWithoutNullStreams {
  console.log(`[start-all] Starting ${processConfig.label}: ${processConfig.command} ${processConfig.args.join(' ')}`);
  const child = spawn(processConfig.command, processConfig.args, {
    env: process.env,
    shell: false,
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${processConfig.label}] ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${processConfig.label}] ${chunk}`);
  });

  child.on('exit', (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    console.log(`[start-all] ${processConfig.label} exited with ${detail}`);
  });

  child.on('error', (error) => {
    console.error(`[start-all] Failed to start ${processConfig.label}: ${error.message}`);
  });

  return child;
}

export function startAll() {
  runSetup();

  const plan = buildStartAllPlan(resolveStartAllOptions());
  const children = plan.processes.map(startProcess);

  if (plan.openBrowser) {
    setTimeout(() => openUrl(plan.appUrl), plan.openBrowserDelayMs);
  }

  const shutdown = () => {
    console.log('[start-all] Stopping services...');
    for (const child of children) {
      if (!child.killed) child.kill();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentPath = fileURLToPath(import.meta.url);

if (entryPath === currentPath) {
  startAll();
}
