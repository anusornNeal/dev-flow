import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildVerificationStageSegments, findRunnableVerificationStepIndex, FULL_VERIFY_PARALLELISM, VERIFICATION_STEPS, verificationStepWeight, type VerificationStep } from './verifyPlan.js';
import { executeAllMigrations } from '../src/db/migrations/index.js';

const MAX_STEP_OUTPUT_BYTES = 20_000;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
export const FULL_VERIFY_DURABLE_BUDGET_MS = 300_000;
export const FULL_VERIFY_HEADROOM_MS = 30_000;
export const FULL_VERIFY_SOFT_LIMIT_MS = FULL_VERIFY_DURABLE_BUDGET_MS - FULL_VERIFY_HEADROOM_MS;

type VerificationStepResult = {
  step: VerificationStep;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  durationMs: number;
};

type VerificationStageResult = {
  failed: VerificationStepResult | null;
  results: VerificationStepResult[];
};

const ACTIVE_STEP_REPORT_INTERVAL_MS = 30_000;

function outputBytes(value: string) {
  return Buffer.byteLength(value, 'utf8');
}

function capOutput(value: string) {
  const bytes = outputBytes(value);
  if (bytes <= MAX_STEP_OUTPUT_BYTES) return value;
  return `${Buffer.from(value, 'utf8').subarray(0, MAX_STEP_OUTPUT_BYTES).toString('utf8')}\n[truncated]`;
}

function appendCaptured(current: string, chunk: Buffer) {
  const currentBytes = outputBytes(current);
  if (currentBytes >= MAX_CAPTURE_BYTES) return current;
  const remaining = MAX_CAPTURE_BYTES - currentBytes;
  return current + chunk.subarray(0, remaining).toString('utf8');
}

function emitFailureOutput(label: string, stdout: string, stderr: string) {
  if (stdout.trim()) console.error(`[verify] ${label} stdout:\n${capOutput(stdout)}`);
  if (stderr.trim()) console.error(`[verify] ${label} stderr:\n${capOutput(stderr)}`);
}

function stepDatabasePath(tempDbDir: string, step: VerificationStep, index: number) {
  if (!step.parallelSafe) return path.join(tempDbDir, 'devflow.db');
  const safeLabel = step.label.replace(/[^A-Za-z0-9_-]+/g, '-');
  return path.join(tempDbDir, `${String(index).padStart(2, '0')}-${safeLabel}.sqlite`);
}

function stepEnvironment(tempDbDir: string, step: VerificationStep, index: number) {
  const env = { ...process.env };
  if (step.databasePathMode === 'self-managed') {
    delete env.DEVFLOW_DB_PATH;
    return env;
  }
  env.DEVFLOW_DB_PATH = stepDatabasePath(tempDbDir, step, index);
  return env;
}

function resolveStepInvocation(step: VerificationStep) {
  const tsxCliPath = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (step.command === 'npx' && step.args[0] === 'tsx' && fs.existsSync(tsxCliPath)) {
    return { executable: process.execPath, args: [tsxCliPath, ...step.args.slice(1)] };
  }
  if (process.platform === 'win32') {
    return { executable: 'cmd.exe', args: ['/c', step.command, ...step.args] };
  }
  return { executable: step.command, args: step.args };
}

function describeActiveSteps(activeSteps: Map<string, number>, now = Date.now()) {
  return [...activeSteps.entries()]
    .map(([label, startedAt]) => ({ label, elapsedMs: now - startedAt }))
    .sort((left, right) => right.elapsedMs - left.elapsedMs)
    .map(({ label, elapsedMs }) => `${label}=${elapsedMs}ms`)
    .join(', ');
}

function reportStageSummary(stage: number, results: VerificationStepResult[]) {
  const slowest = [...results]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 5)
    .map((result) => `${result.step.label}=${result.durationMs}ms`)
    .join(', ');
  if (slowest) console.log(`[verify] Stage ${stage} slowest groups: ${slowest}.`);
}

function runStep(
  step: VerificationStep,
  tempDbDir: string,
  index: number,
  activeSteps: Map<string, number>,
): Promise<VerificationStepResult> {
  console.log(`[verify] Running ${step.label}...`);
  const invocation = resolveStepInvocation(step);
  const startedAt = Date.now();
  activeSteps.set(step.label, startedAt);

  return new Promise((resolve) => {
    const child = spawn(invocation.executable, invocation.args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: stepEnvironment(tempDbDir, step, index),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: Omit<VerificationStepResult, 'step' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      activeSteps.delete(step.label);
      resolve({ step, durationMs: Date.now() - startedAt, ...result });
    };

    child.stdout?.on('data', (chunk) => {
      stdout = appendCaptured(stdout, Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendCaptured(stderr, Buffer.from(chunk));
    });
    child.on('error', (error) => finish({ exitCode: null, stdout, stderr, error }));
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr }));
  });
}

function reportResult(result: VerificationStepResult) {
  if (result.error) {
    console.error(`[verify] ${result.step.label} could not run: ${result.error.message}`);
    emitFailureOutput(result.step.label, result.stdout, result.stderr);
    return false;
  }
  if (result.exitCode !== 0) {
    console.error(`[verify] ${result.step.label} failed with exit ${result.exitCode ?? 'unknown'}.`);
    emitFailureOutput(result.step.label, result.stdout, result.stderr);
    return false;
  }
  console.log(`[verify] ${result.step.label} passed in ${result.durationMs}ms (${outputBytes(result.stdout)} stdout bytes, ${outputBytes(result.stderr)} stderr bytes).`);
  return true;
}

async function runSerialStage(
  steps: VerificationStep[],
  tempDbDir: string,
  activeSteps: Map<string, number>,
): Promise<VerificationStageResult> {
  const results: VerificationStepResult[] = [];
  for (const step of steps) {
    const index = VERIFICATION_STEPS.indexOf(step);
    const result = await runStep(step, tempDbDir, index, activeSteps);
    results.push(result);
    if (!reportResult(result)) return { failed: result, results };
  }
  return { failed: null, results };
}

async function runParallelStage(
  steps: VerificationStep[],
  tempDbDir: string,
  activeSteps: Map<string, number>,
): Promise<VerificationStageResult> {
  const results: VerificationStepResult[] = [];
  const pendingSteps = [...steps];
  let failed: VerificationStepResult | null = null;
  let availableCapacity = FULL_VERIFY_PARALLELISM;
  const activeResources = new Set<string>();
  const running = new Set<Promise<void>>();

  const launch = (step: VerificationStep) => {
    const weight = verificationStepWeight(step);
    const resources = step.exclusiveResources ?? [];
    availableCapacity -= weight;
    for (const resource of resources) activeResources.add(resource);
    let runPromise!: Promise<void>;
    runPromise = runStep(step, tempDbDir, VERIFICATION_STEPS.indexOf(step), activeSteps)
      .then((result) => {
        results.push(result);
        if (!reportResult(result)) failed = result;
      })
      .finally(() => {
        availableCapacity += weight;
        for (const resource of resources) activeResources.delete(resource);
        running.delete(runPromise);
      });
    running.add(runPromise);
  };

  while ((!failed && pendingSteps.length > 0) || running.size > 0) {
    let launched = false;
    while (!failed && pendingSteps.length > 0) {
      const runnableIndex = findRunnableVerificationStepIndex(pendingSteps, availableCapacity, activeResources);
      if (runnableIndex < 0) break;
      const [step] = pendingSteps.splice(runnableIndex, 1);
      launch(step);
      launched = true;
    }
    if (running.size === 0) break;
    if (!launched || pendingSteps.length === 0 || failed) {
      await Promise.race(running);
    }
  }

  await Promise.all(running);
  return { failed, results };
}

export async function runFullVerification() {
  const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-test-'));
  const previousDbPath = process.env.DEVFLOW_DB_PATH;
  process.env.DEVFLOW_DB_PATH = path.join(tempDbDir, 'devflow.db');
  executeAllMigrations();
  const verificationStartedAt = Date.now();
  const activeSteps = new Map<string, number>();
  const activityTimer = setInterval(() => {
    const active = describeActiveSteps(activeSteps);
    if (active) {
      console.error(`[verify] Active groups after ${Date.now() - verificationStartedAt}ms total: ${active}.`);
    }
  }, ACTIVE_STEP_REPORT_INTERVAL_MS);
  activityTimer.unref();

  try {
    const stages = Array.from(new Set(VERIFICATION_STEPS.map((step) => step.stage))).sort((a, b) => a - b);
    for (const [stageIndex, stage] of stages.entries()) {
      const stageStartedAt = Date.now();
      const steps = VERIFICATION_STEPS.filter((step) => step.stage === stage);
      const stageResults: VerificationStepResult[] = [];
      for (const segment of buildVerificationStageSegments(steps)) {
        const segmentResult = segment.parallel && segment.steps.length > 1
          ? await runParallelStage(segment.steps, tempDbDir, activeSteps)
          : await runSerialStage(segment.steps, tempDbDir, activeSteps);
        stageResults.push(...segmentResult.results);
        if (segmentResult.failed) return segmentResult.failed.exitCode ?? 1;
      }
      const elapsedMs = Date.now() - verificationStartedAt;
      console.log(`[verify] Stage ${stage} completed in ${Date.now() - stageStartedAt}ms; total ${elapsedMs}ms.`);
      reportStageSummary(stage, stageResults);
      if (elapsedMs > FULL_VERIFY_SOFT_LIMIT_MS) {
        console.error(`[verify] FULL verification exceeded the ${FULL_VERIFY_SOFT_LIMIT_MS}ms headroom limit inside the ${FULL_VERIFY_DURABLE_BUDGET_MS}ms durable command budget.`);
        return 124;
      }
      if (stageIndex < stages.length - 1) {
        console.log(`[verify] Durable budget remaining with headroom: ${FULL_VERIFY_SOFT_LIMIT_MS - elapsedMs}ms.`);
      }
    }
    console.log(`[verify] Verification completed successfully in ${Date.now() - verificationStartedAt}ms.`);
    return 0;
  } finally {
    clearInterval(activityTimer);
    if (previousDbPath === undefined) delete process.env.DEVFLOW_DB_PATH;
    else process.env.DEVFLOW_DB_PATH = previousDbPath;
    try {
      fs.rmSync(tempDbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.error(`[verify] Temporary verification cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const exitCode = await runFullVerification();
if (exitCode !== 0) process.exitCode = exitCode;
