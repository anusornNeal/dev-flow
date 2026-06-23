import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { enqueueToolJob, getToolJobStatus, cancelToolJob } from '../../src/server/services/mcpToolJobService';
import { readJobLog, readJobResult } from '../../src/server/repositories/mcpToolJobRepository';
import { createProject } from '../../src/server/repositories/projectRepository.js';

try { createProject({ id: 'proj_1', name: 'dev-flow', localPath: process.cwd() }); } catch(e) {}
const MOCK_STATE: any = {
  projects: [{ id: 'proj_1', name: 'dev-flow', localPath: process.cwd() }],
};

test('mcpToolJobService - enqueue and cancel', async () => {
  const jobInfo = enqueueToolJob(MOCK_STATE, 'search_local_files', { query: 'test' }, 'repo-read');
  
  assert.ok(jobInfo.jobId);
  assert.strictEqual(jobInfo.status, 'queued');

  const cancelled = cancelToolJob(jobInfo.jobId);
  assert.strictEqual(cancelled, true);

  const status = getToolJobStatus(jobInfo.jobId);
  assert.strictEqual(status?.status, 'cancelled');
});

test('mcpToolJobService - job execution and result', async () => {
  const jobInfo = enqueueToolJob(MOCK_STATE, 'search_local_files', { query: 'mcpToolJobService' }, 'repo-read');
  
  // Wait for job to finish
  let status = getToolJobStatus(jobInfo.jobId);
  let retries = 0;
  while (status && (status.status === 'queued' || status.status === 'running') && retries < 40) {
    await new Promise(r => setTimeout(r, 100));
    status = getToolJobStatus(jobInfo.jobId);
    retries++;
  }

  assert.strictEqual(status?.status, 'succeeded');
  
  const result = readJobResult(jobInfo.jobId);
  assert.ok(result);
  assert.ok(result.result.count >= 0);
});

test('mcpToolJobService - log tailing', async () => {
  const jobInfo = enqueueToolJob(MOCK_STATE, 'search_local_files', { query: 'mcpToolJobService' }, 'repo-read');
  
  let status = getToolJobStatus(jobInfo.jobId);
  let retries = 0;
  while (status && (status.status === 'queued' || status.status === 'running') && retries < 40) {
    await new Promise(r => setTimeout(r, 100));
    status = getToolJobStatus(jobInfo.jobId);
    retries++;
  }

  const logs = readJobLog(jobInfo.jobId, 'stdout');
  // rg doesn't output to stdout unless matches are found or we're streaming the json, but we just check logs doesn't crash
  assert.strictEqual(typeof logs.log, 'string');
});
