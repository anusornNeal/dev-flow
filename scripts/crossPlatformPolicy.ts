export type CrossPlatformViolationCode = 'HARDCODED_HOME_PATH' | 'SHELL_TRUE_SHARED_RUNTIME';

export type CrossPlatformViolation = {
  code: CrossPlatformViolationCode;
  filePath: string;
  line: number;
  preview: string;
};

export function findCrossPlatformViolations(filePath: string, source: string): CrossPlatformViolation[] {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const violations: CrossPlatformViolation[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const hardcodedWindowsHome = /[A-Za-z]:[\\/]Users[\\/][^\\/'"`\s]+/g;
    const hardcodedMacHome = /\/Users\/[^/'"`\s]+/g;
    for (const _match of line.matchAll(hardcodedWindowsHome)) {
      violations.push({ code: 'HARDCODED_HOME_PATH', filePath: normalizedPath, line: lineNumber, preview: line.trim() });
    }
    for (const _match of line.matchAll(hardcodedMacHome)) {
      violations.push({ code: 'HARDCODED_HOME_PATH', filePath: normalizedPath, line: lineNumber, preview: line.trim() });
    }
    if (/\bshell\s*:\s*true\b/.test(line)) {
      violations.push({ code: 'SHELL_TRUE_SHARED_RUNTIME', filePath: normalizedPath, line: lineNumber, preview: line.trim() });
    }
  });
  return violations;
}
