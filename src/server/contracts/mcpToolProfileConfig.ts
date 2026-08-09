import fs from 'node:fs';
import { resolveFromDevFlowAppRoot } from '../../lib/devFlowPaths';
import {
  DEVFLOW_RESTART_SUPERVISOR_ENV,
  DEVFLOW_RESTART_SUPERVISOR_START_ALL,
} from '../../lib/devFlowRestart';

const MCP_TOOL_PROFILE_ENV = 'DEVFLOW_MCP_TOOL_PROFILE';

function stripQuotedEnvValue(raw: string) {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1).trim();
  }
  return value.replace(/\s+#.*$/, '').trim();
}

export function readMcpToolProfileFromEnvFile() {
  const envPath = resolveFromDevFlowAppRoot('.env');
  if (!fs.existsSync(envPath)) return null;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?DEVFLOW_MCP_TOOL_PROFILE\s*=\s*(.*)$/);
      if (!match) continue;
      const value = stripQuotedEnvValue(match[1] || '');
      return value || null;
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveRuntimeMcpToolProfileValue(explicitValue?: string) {
  if (explicitValue !== undefined) return explicitValue;
  if (process.env[DEVFLOW_RESTART_SUPERVISOR_ENV] === DEVFLOW_RESTART_SUPERVISOR_START_ALL) {
    const refreshed = readMcpToolProfileFromEnvFile();
    if (refreshed !== null) return refreshed;
  }
  return process.env[MCP_TOOL_PROFILE_ENV];
}
