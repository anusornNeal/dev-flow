import 'dotenv/config';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  DEVFLOW_RESTART_EXIT_CODE,
  DEVFLOW_RESTART_SUPERVISOR_ENV,
  DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV,
  DEVFLOW_RESTART_SUPERVISOR_START_ALL,
  type DevFlowRestartState,
  markDevFlowRestartFailed,
  markDevFlowRestartRestarting,
  readDevFlowRestartState,
} from '../src/lib/devFlowRestart';

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
  env?: Record<string, string>;
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

export function buildStartAllPlan(options: StartAllOptions, supervisorToken = randomUUID()): StartAllPlan {
  return {
    appUrl: `http://localhost:${options.port}`,
    openBrowser: options.openBrowser,
    openBrowserDelayMs: options.openBrowserDelayMs,
    processes: [
      {
        label: 'server',
        command: executableFor('npm'),
        args: ['run', 'dev'],
        env: {
          [DEVFLOW_RESTART_SUPERVISOR_ENV]: DEVFLOW_RESTART_SUPERVISOR_START_ALL,
          [DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV]: supervisorToken,
        },
      },
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

export function shouldRestartServerProcess(input: {
  label: string;
  exitCode: number | null;
  supervisorToken: string | undefined;
  shuttingDown: boolean;
  restartState: Pick<DevFlowRestartState, 'status' | 'supervisor' | 'supervisorToken'> | null;
}) {
  return !input.shuttingDown
    && input.label === 'server'
    && input.exitCode === DEVFLOW_RESTART_EXIT_CODE
    && input.restartState?.status === 'accepted'
    && input.restartState.supervisor === DEVFLOW_RESTART_SUPERVISOR_START_ALL
    && Boolean(input.supervisorToken) && input.restartState.supervisorToken === input.supervisorToken;
}

type ProcessCallbacks = {
  onExit?: (child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (child: ChildProcessWithoutNullStreams, error: Error) => void;
};

function startProcess(processConfig: ManagedProcess, callbacks: ProcessCallbacks = {}): ChildProcessWithoutNullStreams {
  console.log(`[start-all] Starting ${processConfig.label}: ${processConfig.command} ${processConfig.args.join(' ')}`);
  const child = spawn(processConfig.command, processConfig.args, {
    env: { ...process.env, ...(processConfig.env || {}) },
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
    callbacks.onExit?.(child, code, signal);
  });

  child.on('error', (error) => {
    console.error(`[start-all] Failed to start ${processConfig.label}: ${error.message}`);
    callbacks.onError?.(child, error);
  });

  return child;
}

export function startAll() {
  runSetup();

  const plan = buildStartAllPlan(resolveStartAllOptions());
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  let shuttingDown = false;

  const launch = (processConfig: ManagedProcess): ChildProcessWithoutNullStreams => {
    const child = startProcess(processConfig, {
      onExit: (exitedChild, code, signal) => {
        if (children.get(processConfig.label) === exitedChild) {
          children.delete(processConfig.label);
        }

        const restartState = readDevFlowRestartState();
        const supervisorToken = processConfig.env?.[DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV];
        if (shouldRestartServerProcess({
          label: processConfig.label,
          exitCode: code,
          supervisorToken,
          shuttingDown,
          restartState,
        })) {
          console.log(`[start-all] Restart ticket ${restartState!.ticket} accepted; relaunching DevFlow server.`);
          try {
            const replacement = launch(processConfig);
            if (!replacement.pid) {
              markDevFlowRestartFailed(restartState!.ticket, 'Restart supervisor could not resolve the replacement server process id.');
              return;
            }
            markDevFlowRestartRestarting(restartState!.ticket, replacement.pid);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            markDevFlowRestartFailed(restartState!.ticket, `Restart supervisor failed to relaunch DevFlow: ${message}`);
          }
          return;
        }

        if (
          !shuttingDown
          && processConfig.label === 'server'
          && restartState?.status === 'accepted'
          && restartState.supervisorToken === supervisorToken
        ) {
          const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
          markDevFlowRestartFailed(restartState.ticket, `DevFlow exited with ${detail} before restart handoff completed.`);
          return;
        }

        if (
          !shuttingDown
          && processConfig.label === 'server'
          && restartState?.status === 'restarting'
          && restartState.replacementPid === exitedChild.pid
        ) {
          const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
          markDevFlowRestartFailed(restartState.ticket, `Replacement DevFlow server exited with ${detail} before becoming healthy.`);
        }
      },
      onError: (failedChild, error) => {
        const restartState = readDevFlowRestartState();
        if (
          !shuttingDown
          && processConfig.label === 'server'
          && restartState?.status === 'restarting'
          && restartState.replacementPid === failedChild.pid
        ) {
          markDevFlowRestartFailed(restartState.ticket, `Replacement DevFlow server failed to start: ${error.message}`);
        }
      },
    });

    children.set(processConfig.label, child);
    return child;
  };

  for (const processConfig of plan.processes) {
    launch(processConfig);
  }

  if (plan.openBrowser) {
    setTimeout(() => openUrl(plan.appUrl), plan.openBrowserDelayMs);
  }

  const shutdown = () => {
    shuttingDown = true;
    console.log('[start-all] Stopping services...');
    for (const child of children.values()) {
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
