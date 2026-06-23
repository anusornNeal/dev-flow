import fs from 'fs';
import path from 'path';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted';

export interface McpToolJob {
  jobId: string;
  toolName: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  args: any;
  resourceKey: string;
}

const JOBS_DIR = path.resolve(getDevFlowAppRoot(), '.devflow', 'jobs');
const SECRET_KEY_PATTERN = /(token|secret|password|pass|apikey|api_key|authorization|cookie)/i;
const MAX_LOG_READ_BYTES = 200_000;

function redactValue(value: any): any {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  const copy: Record<string, any> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    copy[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactValue(nestedValue);
  }
  return copy;
}

function getJobDir(jobId: string) {
  return path.join(JOBS_DIR, jobId);
}

function ensureJobsDir() {
  if (!fs.existsSync(JOBS_DIR)) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
  }
}

function readTail(filePath: string, maxBytes: number) {
  if (!fs.existsSync(filePath)) return { text: '', truncated: false, bytes: 0, returnedBytes: 0 };
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return {
      text: buffer.toString('utf8'),
      truncated: stat.size > length,
      bytes: stat.size,
      returnedBytes: length,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function createJob(jobId: string, toolName: string, args: any, resourceKey: string): McpToolJob {
  ensureJobsDir();
  const jobDir = getJobDir(jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const safeArgs = redactValue(args);
  const now = new Date().toISOString();
  
  const job: McpToolJob = {
    jobId,
    toolName,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    args: safeArgs,
    resourceKey
  };
  
  fs.writeFileSync(path.join(jobDir, 'input.json'), JSON.stringify({ toolName, args: safeArgs, resourceKey }, null, 2));
  fs.writeFileSync(path.join(jobDir, 'status.json'), JSON.stringify(job, null, 2));
  fs.writeFileSync(path.join(jobDir, 'stdout.log'), '');
  fs.writeFileSync(path.join(jobDir, 'stderr.log'), '');
  
  return job;
}

export function getJob(jobId: string): McpToolJob | null {
  const jobDir = getJobDir(jobId);
  if (!fs.existsSync(jobDir)) return null;
  try {
    const statusPath = path.join(jobDir, 'status.json');
    if (!fs.existsSync(statusPath)) return null;
    return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch {
    return null;
  }
}

export function updateJobStatus(jobId: string, updates: Partial<McpToolJob>): McpToolJob | null {
  const job = getJob(jobId);
  if (!job) return null;
  const updated = { ...job, ...updates, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(getJobDir(jobId), 'status.json'), JSON.stringify(updated, null, 2));
  return updated;
}

export function appendJobLog(jobId: string, stream: 'stdout' | 'stderr', data: string) {
  const jobDir = getJobDir(jobId);
  if (!fs.existsSync(jobDir)) return;
  fs.appendFileSync(path.join(jobDir, `${stream}.log`), data);
}

export function writeJobResult(jobId: string, result: any) {
  const jobDir = getJobDir(jobId);
  if (!fs.existsSync(jobDir)) return;
  fs.writeFileSync(path.join(jobDir, 'result.json'), JSON.stringify(result, null, 2));
  if (result?.patch) {
    fs.writeFileSync(path.join(jobDir, 'patch.diff'), result.patch);
  }
}

export function readJobLog(jobId: string, stream: 'stdout' | 'stderr' | 'both'): { log: string; truncated: boolean; bytes: number; returnedBytes: number } {
  const jobDir = getJobDir(jobId);
  if (!fs.existsSync(jobDir)) return { log: '', truncated: false, bytes: 0, returnedBytes: 0 };
  if (stream === 'both') {
    const out = readTail(path.join(jobDir, 'stdout.log'), Math.floor(MAX_LOG_READ_BYTES / 2));
    const err = readTail(path.join(jobDir, 'stderr.log'), Math.floor(MAX_LOG_READ_BYTES / 2));
    return {
      log: `${out.text}${err.text}`,
      truncated: out.truncated || err.truncated,
      bytes: out.bytes + err.bytes,
      returnedBytes: out.returnedBytes + err.returnedBytes,
    };
  }
  const tail = readTail(path.join(jobDir, `${stream}.log`), MAX_LOG_READ_BYTES);
  return { log: tail.text, truncated: tail.truncated, bytes: tail.bytes, returnedBytes: tail.returnedBytes };
}

export function readJobResult(jobId: string): any {
  const jobDir = getJobDir(jobId);
  if (!fs.existsSync(jobDir)) return null;
  const resultPath = path.join(jobDir, 'result.json');
  if (!fs.existsSync(resultPath)) return null;
  try {
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const patchPath = path.join(jobDir, 'patch.diff');
    return {
      result,
      patch: fs.existsSync(patchPath) ? readTail(patchPath, 500_000).text : undefined,
    };
  } catch {
    return null;
  }
}

export function listInterruptedJobs(): McpToolJob[] {
  ensureJobsDir();
  const dirs = fs.readdirSync(JOBS_DIR);
  const interrupted: McpToolJob[] = [];
  
  for (const dir of dirs) {
    const jobDir = path.join(JOBS_DIR, dir);
    if (!fs.statSync(jobDir).isDirectory()) continue;
    
    const job = getJob(dir);
    if (job && (job.status === 'queued' || job.status === 'running')) {
      const updated = updateJobStatus(job.jobId, { status: 'interrupted' });
      if (updated) interrupted.push(updated);
    }
  }
  
  return interrupted;
}
