import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DEVFLOW_APP_ROOT = path.resolve(__dirname, '..', '..');

export function getDevFlowAppRoot() {
  return path.resolve(process.env.DEVFLOW_APP_ROOT || DEFAULT_DEVFLOW_APP_ROOT);
}

export function resolveFromDevFlowAppRoot(...segments: string[]) {
  return path.join(getDevFlowAppRoot(), ...segments);
}

export function getDevFlowDataDir() {
  return resolveFromDevFlowAppRoot('data');
}

export function getDevFlowDbPath() {
  return process.env.DEVFLOW_DB_PATH || path.join(getDevFlowDataDir(), 'devflow.db');
}

export function getDevFlowSchemaPath() {
  return resolveFromDevFlowAppRoot('src', 'db', 'schema.sql');
}

export function getDevFlowSkillsDir() {
  return resolveFromDevFlowAppRoot('skills');
}

export function getDevFlowUploadsDir() {
  return resolveFromDevFlowAppRoot('data', 'uploads');
}

export function getTaskUploadsDir(taskId: string) {
  return path.join(getDevFlowUploadsDir(), 'tasks', taskId);
}

export function getDevFlowBackupsDir() {
  return resolveFromDevFlowAppRoot('data', 'backups');
}

export function getDevFlowCacheDir() {
  return resolveFromDevFlowAppRoot('.devflow', 'cache');
}

export function getProjectAtlasCacheDir() {
  return path.join(getDevFlowCacheDir(), 'project-atlas');
}

export function getProjectAtlasCachePath(projectId: string) {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(getProjectAtlasCacheDir(), `${safeProjectId}.json`);
}
