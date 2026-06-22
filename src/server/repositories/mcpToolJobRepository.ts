import fs from 'fs';
import path from 'path';

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

const JOBS_DIR = path.resolve(process.cwd(), '.devflow', 'jobs');

function getJobDir(jobId: string) {
  return path.join(JOBS_DIR, jobId);
}

function ensureJobsDir() {
  if (!fs.existsSync(JOBS_DIR)) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
  }
}

export function createJob(jobId: string, toolName: string, args: any, resourceKey: string): McpToolJob {
  ensureJobsDir();
  const jobDir = getJobDir(jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  
  const job: McpToolJob = {
    jobId,
    toolName,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    args,
    resourceKey
  };
  
  fs.writeFileSync(path.join(jobDir, 'input.json'), JSON.stringify({ toolName, args, resourceKey }, null, 2));
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
  if (result.patch) {
    fs.writeFileSync(path.join(jobDir, 'patch.diff'), result.patch);
  }
}

export function readJobLog(jobId: string, stream: 'stdout' | 'stderr' | 'both'): string {
  const jobDir = getJobDir(jobId);
  if (!fs.existsSync(jobDir)) return '';
  if (stream === 'both') {
    const out = fs.existsSync(path.join(jobDir, 'stdout.log')) ? fs.readFileSync(path.join(jobDir, 'stdout.log'), 'utf8') : '';
    const err = fs.existsSync(path.join(jobDir, 'stderr.log')) ? fs.readFileSync(path.join(jobDir, 'stderr.log'), 'utf8') : '';
    return out + err;
  }
  const logFile = path.join(jobDir, `${stream}.log`);
  if (!fs.existsSync(logFile)) return '';
  return fs.readFileSync(logFile, 'utf8');
}

export function readJobResult(jobId: string): any {
  const jobDir = getJobDir(jobId);
  if (!fs.existsSync(jobDir)) return null;
  const resultPath = path.join(jobDir, 'result.json');
  if (!fs.existsSync(resultPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
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
