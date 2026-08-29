import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildVerificationStageSegments, FULL_VERIFY_PARALLELISM, VERIFICATION_STEPS, type VerificationStep } from './verifyPlan.js';

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

function runStep(step: VerificationStep, tempDbDir: string, index: number): Promise<VerificationStepResult> {
  console.log(`[verify] Running ${step.label}...`);
  const executable = process.platform === 'win32' ? 'cmd.exe' : step.command;
  const finalArgs = process.platform === 'win32' ? ['/c', step.command, ...step.args] : step.args;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(executable, finalArgs, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEVFLOW_DB_PATH: stepDatabasePath(tempDbDir, step, index),
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: Omit<VerificationStepResult, 'step' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
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

async function runSerialStage(steps: VerificationStep[], tempDbDir: string) {
  for (const step of steps) {
    const index = VERIFICATION_STEPS.indexOf(step);
    const result = await runStep(step, tempDbDir, index);
    if (!reportResult(result)) return result;
  }
  return null;
}

async function runParallelStage(steps: VerificationStep[], tempDbDir: string) {
  let nextIndex = 0;
  let failed: VerificationStepResult | null = null;
  const workerCount = Math.min(FULL_VERIFY_PARALLELISM, steps.length);

  const worker = async () => {
    while (!failed) {
      const localIndex = nextIndex;
      nextIndex += 1;
      if (localIndex >= steps.length) return;
      const step = steps[localIndex];
      const result = await runStep(step, tempDbDir, VERIFICATION_STEPS.indexOf(step));
      if (!reportResult(result)) {
        failed = result;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return failed;
}

export async function runFullVerification() {
  const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-test-'));
  const previousDbPath = process.env.DEVFLOW_DB_PATH;
  process.env.DEVFLOW_DB_PATH = path.join(tempDbDir, 'devflow.db');
  const verificationStartedAt = Date.now();

  try {
    const stages = Array.from(new Set(VERIFICATION_STEPS.map((step) => step.stage))).sort((a, b) => a - b);
    for (const [stageIndex, stage] of stages.entries()) {
      const stageStartedAt = Date.now();
      const steps = VERIFICATION_STEPS.filter((step) => step.stage === stage);
      for (const segment of buildVerificationStageSegments(steps)) {
        const failed = segment.parallel && segment.steps.length > 1
          ? await runParallelStage(segment.steps, tempDbDir)
          : await runSerialStage(segment.steps, tempDbDir);
        if (failed) return failed.exitCode ?? 1;
      }
      const elapsedMs = Date.now() - verificationStartedAt;
      console.log(`[verify] Stage ${stage} completed in ${Date.now() - stageStartedAt}ms; total ${elapsedMs}ms.`);
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
    if (previousDbPath === undefined) delete process.env.DEVFLOW_DB_PATH;
    else process.env.DEVFLOW_DB_PATH = previousDbPath;
    fs.rmSync(tempDbDir, { recursive: true, force: true });
  }
}

const exitCode = await runFullVerification();
if (exitCode !== 0) process.exitCode = exitCode;
