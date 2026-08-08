import path from 'node:path';

export type SupportedPlatform = NodeJS.Platform;

export function normalizeLocalPathIdentity(value: unknown, platform: SupportedPlatform = process.platform) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const looksWindows = /^[a-zA-Z]:[\\/]/.test(raw) || raw.includes('\\');
  const resolved = looksWindows ? path.win32.resolve(raw) : path.posix.resolve(raw);
  const normalized = resolved.replace(/\\/g, '/').replace(/\/+$/g, '');
  return platform === 'win32' && looksWindows ? normalized.toLowerCase() : normalized;
}

export function resolvePackageManagerInvocation(
  command: 'npm' | 'npx',
  args: string[],
  options: {
    platform?: SupportedPlatform;
    execPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const explicitCli = String(command === 'npm' ? env.npm_execpath || '' : env.npx_execpath || '').trim();
  if (explicitCli) return { executable: execPath, args: [explicitCli, ...args], shell: false as const };
  if (platform === 'win32') {
    const cliName = command === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
    return {
      executable: execPath,
      args: [path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', cliName), ...args],
      shell: false as const,
    };
  }
  return { executable: command, args: [...args], shell: false as const };
}

export function normalizeRepoRelativePath(root: string, absolutePath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(absolutePath));
  return relative.replace(/\\/g, '/') || '.';
}
