import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDevFlowDataDir } from '../../lib/devFlowPaths.js';

export type CredentialKey = 'githubToken' | 'jiraToken' | 'figmaToken';

export interface CredentialVaultProvider {
  readonly name: string;
  isAvailable(): boolean;
  get(key: CredentialKey): string;
  set(key: CredentialKey, value: string): void;
  delete(key: CredentialKey): void;
}

const ENV_KEYS: Record<CredentialKey, string[]> = {
  githubToken: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN'],
  jiraToken: ['JIRA_API_TOKEN', 'JIRA_PERSONAL_ACCESS_TOKEN'],
  figmaToken: ['FIGMA_ACCESS_TOKEN', 'FIGMA_PERSONAL_ACCESS_TOKEN'],
};

function resolveVaultPath() {
  const explicit = process.env.DEVFLOW_CREDENTIAL_VAULT_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  const dbPath = process.env.DEVFLOW_DB_PATH?.trim();
  if (dbPath) return path.join(path.dirname(path.resolve(dbPath)), 'credentials.vault.json');
  return path.join(getDevFlowDataDir(), 'credentials.vault.json');
}

function readJsonFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
}

function writeJsonFileAtomic(filePath: string, value: Record<string, string>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {}
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

export class WindowsDpapiCredentialVaultProvider implements CredentialVaultProvider {
  readonly name = 'windows-dpapi';
  private availability: boolean | null = null;
  private readonly cache = new Map<CredentialKey, string>();

  constructor(private readonly filePath = resolveVaultPath()) {}

  isAvailable() {
    if (process.platform !== 'win32') return false;
    if (this.availability !== null) return this.availability;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    this.availability = result.status === 0;
    return this.availability;
  }

  get(key: CredentialKey) {
    if (!this.isAvailable()) return '';
    if (this.cache.has(key)) return this.cache.get(key) || '';
    const encrypted = readJsonFile(this.filePath)[key];
    if (!encrypted) return '';
    const script = [
      '$bytes=[Convert]::FromBase64String($env:DEVFLOW_DPAPI_BLOB)',
      '$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Text.Encoding]::UTF8.GetString($plain)',
    ].join(';');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, DEVFLOW_DPAPI_BLOB: encrypted },
    });
    if (result.status !== 0) {
      throw new Error(`Credential vault read failed for ${key}.`);
    }
    const value = String(result.stdout || '').replace(/\r?\n$/, '');
    this.cache.set(key, value);
    return value;
  }

  set(key: CredentialKey, value: string) {
    if (!this.isAvailable()) throw new Error('Secure credential storage is unavailable on this platform.');
    const script = [
      '$plain=[Text.Encoding]::UTF8.GetBytes($env:DEVFLOW_SECRET_VALUE)',
      '$encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Convert]::ToBase64String($encrypted)',
    ].join(';');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, DEVFLOW_SECRET_VALUE: value },
    });
    if (result.status !== 0) {
      throw new Error(`Credential vault write failed for ${key}.`);
    }
    const entries = readJsonFile(this.filePath);
    entries[key] = String(result.stdout || '').trim();
    writeJsonFileAtomic(this.filePath, entries);
    this.cache.set(key, value);
  }

  delete(key: CredentialKey) {
    this.cache.delete(key);
    if (!fs.existsSync(this.filePath)) return;
    const entries = readJsonFile(this.filePath);
    if (!(key in entries)) return;
    delete entries[key];
    writeJsonFileAtomic(this.filePath, entries);
  }
}

export function createMemoryCredentialVaultProvider(): CredentialVaultProvider {
  const values = new Map<CredentialKey, string>();
  return {
    name: 'memory',
    isAvailable: () => true,
    get: (key) => values.get(key) || '',
    set: (key, value) => { values.set(key, value); },
    delete: (key) => { values.delete(key); },
  };
}

export function createUnavailableCredentialVaultProvider(name = 'env-only'): CredentialVaultProvider {
  return {
    name,
    isAvailable: () => false,
    get: () => '',
    set: () => { throw new Error('Secure credential storage is unavailable on this platform.'); },
    delete: () => {},
  };
}

function createDefaultProvider(): CredentialVaultProvider {
  if (process.platform === 'win32') return new WindowsDpapiCredentialVaultProvider();
  return createUnavailableCredentialVaultProvider(`${process.platform}-env-only`);
}

let activeProvider: CredentialVaultProvider = createDefaultProvider();

function environmentCredential(key: CredentialKey) {
  for (const envKey of ENV_KEYS[key]) {
    const value = process.env[envKey]?.trim();
    if (value) return value;
  }
  return '';
}

export function getCredential(key: CredentialKey) {
  const envValue = environmentCredential(key);
  if (envValue) return envValue;
  if (!activeProvider.isAvailable()) return '';
  return activeProvider.get(key);
}

export function setCredential(key: CredentialKey, value: string) {
  const normalized = value.trim();
  if (!normalized) {
    activeProvider.delete(key);
    return;
  }
  if (!activeProvider.isAvailable()) {
    throw new Error('Secure credential storage is unavailable; use an environment variable instead.');
  }
  activeProvider.set(key, normalized);
}

export function deleteCredential(key: CredentialKey) {
  activeProvider.delete(key);
}

export function migrateLegacyCredentials(values: Partial<Record<CredentialKey, string>>) {
  const keys = Object.keys(values) as CredentialKey[];
  if (!activeProvider.isAvailable()) {
    return { migrated: [] as CredentialKey[], deferred: keys.filter((key) => Boolean(values[key]?.trim())) };
  }
  const migrated: CredentialKey[] = [];
  const deferred: CredentialKey[] = [];
  for (const key of keys) {
    const legacy = values[key]?.trim();
    if (!legacy) continue;
    try {
      if (!activeProvider.get(key)) activeProvider.set(key, legacy);
      if (activeProvider.get(key) === legacy) migrated.push(key);
      else deferred.push(key);
    } catch {
      deferred.push(key);
    }
  }
  return { migrated, deferred };
}

export function getCredentialVaultDiagnostics() {
  return {
    provider: activeProvider.name,
    securePersistenceAvailable: activeProvider.isAvailable(),
    fallback: activeProvider.isAvailable() ? 'environment-override' : 'environment-only',
  };
}

export function redactCredentialText(text: string, secrets?: string[]) {
  const values = (secrets || [getCredential('githubToken'), getCredential('jiraToken'), getCredential('figmaToken')])
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let redacted = text;
  for (const value of values) redacted = redacted.split(value).join('[REDACTED]');
  return redacted;
}

export function setCredentialVaultProviderForTests(provider: CredentialVaultProvider) {
  activeProvider = provider;
}

export function resetCredentialVaultProviderForTests() {
  activeProvider = createDefaultProvider();
}
