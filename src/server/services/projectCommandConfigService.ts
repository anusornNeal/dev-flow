import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { createApiError } from './api';
import { resolveSafePath } from './localFileService';
import { readWorkspaceMetadataFile } from './workspaceMetadataCacheService';
import type { VerificationImpactRule } from './verificationPlannerService';

const MAX_CONFIG_BYTES = 100_000;
export const PROJECT_COMMAND_CONFIG_RELATIVE_PATHS = [
  '.devflow/commands.yaml',
  '.devflow/commands.json',
] as const;
export const PROJECT_VERIFICATION_IMPACT_RELATIVE_PATH = '.devflow/verification-impact.json' as const;

export type ProjectCommandConfigSnapshot = {
  fingerprint: string;
  relativePaths: string[];
};

export function getProjectCommandConfigSnapshot(root: string): ProjectCommandConfigSnapshot {
  const relevantPaths = [...PROJECT_COMMAND_CONFIG_RELATIVE_PATHS, PROJECT_VERIFICATION_IMPACT_RELATIVE_PATH];
  const entries = relevantPaths.flatMap((relativePath) => {
    const absolutePath = path.resolve(root, relativePath);
    if (!fs.existsSync(absolutePath)) return [];
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Command config '${relativePath}' must be a regular file inside the repository.`);
    }
    if (stat.size > MAX_CONFIG_BYTES) {
      throw createApiError(400, 'COMMAND_CONFIG_TOO_LARGE', `Command config must be ${MAX_CONFIG_BYTES} bytes or less.`);
    }
    const normalizedContent = fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n');
    return [{
      relativePath,
      size: Buffer.byteLength(normalizedContent, 'utf8'),
      sha256: crypto.createHash('sha256').update(normalizedContent, 'utf8').digest('hex'),
    }];
  });
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return {
    fingerprint,
    relativePaths: entries.map((entry) => entry.relativePath),
  };
}
const MAX_PRESET_NAME_LENGTH = 64;
const MAX_EXECUTABLE_LENGTH = 200;
const MAX_ARG_LENGTH = 4_000;
const MAX_ARGS = 100;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 100_000;
const ALLOWED_CATEGORIES = new Set(['verification', 'validate', 'test', 'lint', 'build']);
const ALLOWED_KEYS = new Set(['executable', 'args', 'cwd', 'timeoutMs', 'maxOutputBytes', 'category']);
const parsedConfigCache = new Map<string, { size: number; mtimeMs: number; parsed: any; configPath: string }>();

export interface ProjectCommandPreset {
  name: string;
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  category: string;
  configPath: string;
}

function parseScalar(rawValue: string, lineNumber: number): unknown {
  const value = rawValue.trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Invalid quoted value on line ${lineNumber}.`, {
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseStrictCommandYaml(content: string) {
  const result: Record<string, Record<string, unknown>> = {};
  let sawCommands = false;
  let currentCommand = '';
  let readingArgs = false;
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.includes('\t')) {
      throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Tabs are not allowed in commands.yaml (line ${lineNumber}).`);
    }

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      if (trimmed !== 'commands:' || sawCommands) {
        throw createApiError(400, 'INVALID_COMMAND_CONFIG', `commands.yaml must contain one top-level 'commands:' mapping (line ${lineNumber}).`);
      }
      sawCommands = true;
      currentCommand = '';
      readingArgs = false;
      continue;
    }

    if (!sawCommands) {
      throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Define 'commands:' before command presets (line ${lineNumber}).`);
    }

    if (indent === 2) {
      const match = trimmed.match(/^([^:#][^:]*)\s*:\s*$/);
      if (!match) {
        throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Invalid command preset declaration on line ${lineNumber}.`);
      }
      currentCommand = match[1].trim();
      if (Object.prototype.hasOwnProperty.call(result, currentCommand)) {
        throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Duplicate command preset '${currentCommand}'.`);
      }
      result[currentCommand] = {};
      readingArgs = false;
      continue;
    }

    if (!currentCommand) {
      throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Command property has no parent preset (line ${lineNumber}).`);
    }

    if (indent === 4) {
      const separator = trimmed.indexOf(':');
      if (separator <= 0) {
        throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Invalid command property on line ${lineNumber}.`);
      }
      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1);
      if (key === 'args' && !rawValue.trim()) {
        result[currentCommand].args = [];
        readingArgs = true;
      } else {
        result[currentCommand][key] = parseScalar(rawValue, lineNumber);
        readingArgs = false;
      }
      continue;
    }

    if (indent === 6 && readingArgs && trimmed.startsWith('- ')) {
      (result[currentCommand].args as unknown[]).push(parseScalar(trimmed.slice(2), lineNumber));
      continue;
    }

    throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Unsupported YAML structure on line ${lineNumber}. Use only the documented commands schema.`);
  }

  if (!sawCommands) {
    throw createApiError(400, 'INVALID_COMMAND_CONFIG', "commands.yaml is missing the top-level 'commands:' mapping.");
  }
  return { commands: result };
}

function readConfig(root: string) {
  const yamlPath = path.resolve(root, PROJECT_COMMAND_CONFIG_RELATIVE_PATHS[0]);
  const jsonPath = path.resolve(root, PROJECT_COMMAND_CONFIG_RELATIVE_PATHS[1]);
  const yamlExists = fs.existsSync(yamlPath);
  const jsonExists = fs.existsSync(jsonPath);

  if (yamlExists && jsonExists) {
    throw createApiError(409, 'COMMAND_CONFIG_AMBIGUOUS', 'Both .devflow/commands.yaml and .devflow/commands.json exist. Keep only one command configuration file.');
  }
  if (!yamlExists && !jsonExists) return null;

  const configPath = yamlExists ? yamlPath : jsonPath;
  const stat = fs.lstatSync(configPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Command config '${path.relative(root, configPath)}' is not a file.`);
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    throw createApiError(400, 'COMMAND_CONFIG_TOO_LARGE', `Command config must be ${MAX_CONFIG_BYTES} bytes or less.`);
  }

  const metadata = readWorkspaceMetadataFile(configPath, MAX_CONFIG_BYTES);
  if (!metadata) {
    throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Command config '${path.relative(root, configPath)}' disappeared before it could be read.`);
  }
  const cacheKey = path.resolve(configPath);
  const cached = parsedConfigCache.get(cacheKey);
  if (cached && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
    return { parsed: cached.parsed, configPath: cached.configPath };
  }

  try {
    const parsed = yamlExists ? parseStrictCommandYaml(metadata.content) : JSON.parse(metadata.content);
    const relativeConfigPath = path.relative(root, configPath).replace(/\\/g, '/');
    parsedConfigCache.set(cacheKey, { size: metadata.size, mtimeMs: metadata.mtimeMs, parsed, configPath: relativeConfigPath });
    return { parsed, configPath: relativeConfigPath };
  } catch (error) {
    if (error && typeof error === 'object' && 'payload' in error) throw error;
    throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Could not parse '${path.relative(root, configPath)}'.`, {
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function validatePresetName(name: string) {
  if (!name || name.length > MAX_PRESET_NAME_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(name)) {
    throw createApiError(400, 'INVALID_COMMAND_NAME', `Command preset '${name}' must use 1-${MAX_PRESET_NAME_LENGTH} letters, numbers, ':', '_', or '-'.`, {
      affectedId: name || undefined,
    });
  }
}

function validateExecutable(value: unknown, name: string) {
  const executable = typeof value === 'string' ? value.trim() : '';
  if (!executable) {
    throw createApiError(400, 'COMMAND_CONFIG_EXECUTABLE_REQUIRED', `Preset '${name}' requires a non-empty executable.`);
  }
  if (executable.length > MAX_EXECUTABLE_LENGTH || !/^[A-Za-z0-9._+-]+$/.test(executable)) {
    throw createApiError(400, 'COMMAND_CONFIG_UNSAFE_EXECUTABLE', `Preset '${name}' executable must be a command name without paths, spaces, or shell syntax.`, {
      affectedId: executable,
    });
  }
  return executable;
}

function validateArgs(value: unknown, name: string) {
  if (!Array.isArray(value)) {
    throw createApiError(400, 'COMMAND_CONFIG_ARGS_REQUIRED', `Preset '${name}' requires an args array.`);
  }
  if (value.length > MAX_ARGS) {
    throw createApiError(400, 'COMMAND_CONFIG_TOO_MANY_ARGS', `Preset '${name}' may define at most ${MAX_ARGS} arguments.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw createApiError(400, 'COMMAND_CONFIG_INVALID_ARG', `Preset '${name}' argument ${index + 1} must be a string.`);
    }
    if (entry.length > MAX_ARG_LENGTH) {
      throw createApiError(400, 'COMMAND_CONFIG_ARG_TOO_LARGE', `Preset '${name}' argument ${index + 1} exceeds ${MAX_ARG_LENGTH} characters.`);
    }
    if (/[;&|<>`\r\n\0]/.test(entry) || entry.includes('$(')) {
      throw createApiError(400, 'COMMAND_CONFIG_UNSAFE_ARG', `Preset '${name}' argument ${index + 1} contains shell-control syntax. Pass executable and literal arguments only.`, {
        details: { index, value: entry },
      });
    }
    return entry;
  });
}

function validateBoundedInteger(value: unknown, field: string, name: string, max: number) {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > max) {
    throw createApiError(400, `COMMAND_CONFIG_INVALID_${field.toUpperCase()}`, `Preset '${name}' ${field} must be an integer from 1 to ${max}.`);
  }
  return numeric;
}

export function loadProjectCommandPreset(root: string, commandName: string): ProjectCommandPreset | null {
  validatePresetName(commandName);
  const config = readConfig(root);
  if (!config) return null;

  const commands = config.parsed?.commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
    throw createApiError(400, 'INVALID_COMMAND_CONFIG', `Command config '${config.configPath}' requires a 'commands' object.`);
  }
  const rawPreset = commands[commandName];
  if (rawPreset === undefined) return null;
  if (!rawPreset || typeof rawPreset !== 'object' || Array.isArray(rawPreset)) {
    throw createApiError(400, 'INVALID_COMMAND_CONFIG_PRESET', `Preset '${commandName}' must be an object.`);
  }

  for (const key of Object.keys(rawPreset)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw createApiError(400, 'COMMAND_CONFIG_UNKNOWN_FIELD', `Preset '${commandName}' contains unsupported field '${key}'.`);
    }
  }

  const category = typeof rawPreset.category === 'string' && rawPreset.category.trim()
    ? rawPreset.category.trim().toLowerCase()
    : 'verification';
  if (!ALLOWED_CATEGORIES.has(category)) {
    throw createApiError(403, 'COMMAND_CONFIG_CATEGORY_DENIED', `Preset '${commandName}' category '${category}' is not allowed by the verification runner. Use a dedicated mutation tool instead.`, {
      affectedId: category,
    });
  }

  const cwd = typeof rawPreset.cwd === 'string' && rawPreset.cwd.trim() ? rawPreset.cwd.trim() : undefined;
  if (cwd) {
    try {
      resolveSafePath(root, cwd);
    } catch {
      throw createApiError(403, 'COMMAND_CONFIG_CWD_DENIED', `Preset '${commandName}' cwd must stay inside the project root.`, { affectedId: cwd });
    }
  }

  return {
    name: commandName,
    executable: validateExecutable(rawPreset.executable, commandName),
    args: validateArgs(rawPreset.args, commandName),
    cwd,
    timeoutMs: validateBoundedInteger(rawPreset.timeoutMs, 'timeoutMs', commandName, MAX_TIMEOUT_MS),
    maxOutputBytes: validateBoundedInteger(rawPreset.maxOutputBytes, 'maxOutputBytes', commandName, MAX_OUTPUT_BYTES),
    category,
    configPath: config.configPath,
  };
}

const MAX_IMPACT_RULES = 100;
const MAX_IMPACT_PATTERNS = 50;
const MAX_IMPACT_COMMANDS = 20;
const MAX_IMPACT_TEXT = 500;

function validateImpactStringList(value: unknown, field: string, ruleId: string, maxItems: number) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw createApiError(400, 'INVALID_VERIFICATION_IMPACT_CONFIG', `Impact rule '${ruleId}' ${field} must contain 1-${maxItems} string values.`);
  }
  return Array.from(new Set(value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > MAX_IMPACT_TEXT || /[\r\n\0]/.test(entry)) {
      throw createApiError(400, 'INVALID_VERIFICATION_IMPACT_CONFIG', `Impact rule '${ruleId}' contains an invalid ${field} value.`);
    }
    return entry.trim().replace(/\\/g, '/');
  })));
}

export function loadProjectVerificationImpactRules(root: string): VerificationImpactRule[] {
  const configPath = path.resolve(root, PROJECT_VERIFICATION_IMPACT_RELATIVE_PATH);
  if (!fs.existsSync(configPath)) return [];
  const stat = fs.lstatSync(configPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
    throw createApiError(400, 'INVALID_VERIFICATION_IMPACT_CONFIG', `Verification impact config '${PROJECT_VERIFICATION_IMPACT_RELATIVE_PATH}' must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes.`);
  }
  const metadata = readWorkspaceMetadataFile(configPath, MAX_CONFIG_BYTES);
  if (!metadata) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(metadata.content);
  } catch (error) {
    throw createApiError(400, 'INVALID_VERIFICATION_IMPACT_CONFIG', `Could not parse '${PROJECT_VERIFICATION_IMPACT_RELATIVE_PATH}'.`, {
      details: error instanceof Error ? error.message : String(error),
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.rules) || parsed.rules.length > MAX_IMPACT_RULES) {
    throw createApiError(400, 'INVALID_VERIFICATION_IMPACT_CONFIG', `Verification impact config requires a 'rules' array with at most ${MAX_IMPACT_RULES} entries.`);
  }

  return parsed.rules.map((raw: any, index: number) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw createApiError(400, 'INVALID_VERIFICATION_IMPACT_CONFIG', `Verification impact rule ${index + 1} must be an object.`);
    }
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `rule-${index + 1}`;
    if (id.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(id)) {
      throw createApiError(400, 'INVALID_VERIFICATION_IMPACT_CONFIG', `Verification impact rule id '${id}' is invalid.`);
    }
    const lane = raw.lane === undefined ? undefined : String(raw.lane).trim().toLowerCase();
    if (lane !== undefined && lane !== 'fast' && lane !== 'safe' && lane !== 'full') {
      throw createApiError(400, 'INVALID_VERIFICATION_IMPACT_CONFIG', `Impact rule '${id}' lane must be fast, safe, or full.`);
    }
    const reason = raw.reason === undefined ? undefined : String(raw.reason).trim();
    if (reason !== undefined && (reason.length > MAX_IMPACT_TEXT || /[\r\n\0]/.test(reason))) {
      throw createApiError(400, 'INVALID_VERIFICATION_IMPACT_CONFIG', `Impact rule '${id}' reason is invalid.`);
    }
    const commands = validateImpactStringList(raw.commands, 'commands', id, MAX_IMPACT_COMMANDS);
    for (const command of commands) {
      if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(command)) {
        throw createApiError(400, 'INVALID_VERIFICATION_IMPACT_CONFIG', `Impact rule '${id}' command '${command}' is invalid.`);
      }
    }
    return {
      id,
      patterns: validateImpactStringList(raw.patterns, 'patterns', id, MAX_IMPACT_PATTERNS),
      commands,
      ...(lane ? { lane: lane as VerificationImpactRule['lane'] } : {}),
      ...(reason ? { reason } : {}),
    };
  });
}
