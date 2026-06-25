import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { createApiError } from './api';
import { resolveProjectRoot, resolveSafePath } from './localFileService';

const DEFAULT_MAX_BYTES = 12_000;
const MAX_BYTES_LIMIT = 100_000;
const MAX_SNIPPETS = 5;
const MAX_FAILING_FILES = 10;

type ParserKind = 'auto' | 'tsc' | 'node-assertion' | 'devflow-verify' | 'npm-script' | 'unknown';
type ReportStatus = 'passed' | 'failed' | 'unknown';

export interface ParseTestReportResult {
  status: ReportStatus;
  parserKind: Exclude<ParserKind, 'auto'>;
  source: {
    usedRawOutput: boolean;
    reportPaths: string[];
  };
  totals: {
    total: number | null;
    passed: number | null;
    failed: number | null;
    errors: number | null;
    warnings: number | null;
  };
  failingFiles: string[];
  errorSnippets: string[];
  suggestedNextCommand: string | null;
  truncated: boolean;
  consumedBytes: number;
}

type ParsedSummary = Omit<ParseTestReportResult, 'source' | 'truncated' | 'consumedBytes'>;

function clampBytes(value: unknown) {
  return Number.isFinite(Number(value))
    ? Math.max(1, Math.min(MAX_BYTES_LIMIT, Number(value)))
    : DEFAULT_MAX_BYTES;
}

function truncateOutput(value: string, maxBytes: number) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) {
    return { value, truncated: false, consumedBytes: bytes };
  }

  const truncatedValue = `${Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[truncated]`;
  return {
    value: truncatedValue,
    truncated: true,
    consumedBytes: Buffer.byteLength(truncatedValue, 'utf8'),
  };
}

function normalizeReportPath(root: string, reportPath: string) {
  try {
    return resolveSafePath(root, reportPath);
  } catch {
    throw createApiError(403, 'REPORT_PATH_DENIED', 'Requested report path is outside the allowed project root.', {
      affectedId: reportPath,
    });
  }
}

function loadReportFiles(root: string, reportPaths: string[]) {
  const loadedPaths: string[] = [];
  const chunks: string[] = [];

  for (const reportPath of reportPaths) {
    const trimmedPath = reportPath.trim();
    if (!trimmedPath) continue;
    const targetPath = normalizeReportPath(root, trimmedPath);
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      throw createApiError(404, 'REPORT_FILE_NOT_FOUND', `Report file '${trimmedPath}' was not found.`, {
        affectedId: trimmedPath,
      });
    }

    const raw = fs.readFileSync(targetPath, 'utf8');
    loadedPaths.push(path.relative(root, targetPath).replace(/\\/g, '/'));
    chunks.push(raw);
  }

  return {
    reportPaths: loadedPaths,
    content: chunks.join('\n'),
  };
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeFilePath(value: string) {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function buildBaseSummary(): ParsedSummary {
  return {
    status: 'unknown',
    parserKind: 'unknown',
    totals: { total: null, passed: null, failed: null, errors: null, warnings: null },
    failingFiles: [],
    errorSnippets: [],
    suggestedNextCommand: null,
  };
}

function parseTscOutput(output: string): ParsedSummary | null {
  const matches = Array.from(output.matchAll(/([^\s(]+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\): error (TS\d+): (.+)/g));
  if (matches.length === 0) return null;

  const summary = buildBaseSummary();
  summary.status = 'failed';
  summary.parserKind = 'tsc';
  summary.failingFiles = uniqueStrings(matches.map((match) => normalizeFilePath(match[1]))).slice(0, MAX_FAILING_FILES);
  summary.errorSnippets = matches
    .slice(0, MAX_SNIPPETS)
    .map((match) => `${normalizeFilePath(match[1])}:${match[2]} ${match[4]} ${match[5]}`);
  summary.totals.errors = matches.length;
  summary.totals.failed = matches.length;
  summary.suggestedNextCommand = 'npm run typecheck';
  return summary;
}

function parseNodeAssertionOutput(output: string): ParsedSummary | null {
  if (!/AssertionError \[ERR_ASSERTION\]/.test(output)) return null;

  const summary = buildBaseSummary();
  summary.status = 'failed';
  summary.parserKind = 'node-assertion';
  const fileMatches = Array.from(output.matchAll(/\(([^()]+\.(?:ts|tsx|js|jsx)):\d+:\d+\)/g));
  summary.failingFiles = uniqueStrings(fileMatches.map((match) => normalizeFilePath(match[1]))).slice(0, MAX_FAILING_FILES);

  const lines = output.split(/\r?\n/).filter(Boolean);
  summary.errorSnippets = lines.slice(0, MAX_SNIPPETS);
  summary.totals.failed = 1;
  summary.totals.errors = 1;
  summary.suggestedNextCommand = 'npm test';
  return summary;
}

function parseDevflowVerifyOutput(output: string): ParsedSummary | null {
  if (!/\[verify\]/.test(output)) return null;

  const summary = buildBaseSummary();
  summary.parserKind = 'devflow-verify';

  if (/Verification completed successfully\./.test(output) || /all assertions passed/.test(output)) {
    summary.status = 'passed';
    summary.suggestedNextCommand = null;
    return summary;
  }

  const failLines = output
    .split(/\r?\n/)
    .filter((line) => /\bFAIL\b|AssertionError|ERR_ASSERTION|error TS\d+/i.test(line))
    .slice(0, MAX_SNIPPETS);
  if (failLines.length > 0) {
    summary.status = 'failed';
    summary.errorSnippets = failLines;
    summary.totals.failed = failLines.length;
    summary.suggestedNextCommand = 'npm run verify';
    return summary;
  }

  summary.status = 'unknown';
  summary.suggestedNextCommand = 'npm run verify';
  return summary;
}

function parseNpmScriptFailure(output: string): ParsedSummary | null {
  if (!/npm ERR!|^> .+/m.test(output)) return null;

  const summary = buildBaseSummary();
  summary.parserKind = 'npm-script';
  summary.status = /npm ERR!|ERR_ASSERTION|error TS\d+/i.test(output) ? 'failed' : 'unknown';
  summary.errorSnippets = output.split(/\r?\n/).filter(Boolean).slice(0, MAX_SNIPPETS);
  summary.suggestedNextCommand = summary.status === 'failed' ? 'npm test' : null;
  if (summary.status === 'failed') {
    summary.totals.failed = 1;
  }
  return summary;
}

function parseUnknownOutput(output: string): ParsedSummary {
  const summary = buildBaseSummary();
  summary.status = output.trim() ? 'unknown' : 'passed';
  summary.parserKind = 'unknown';
  summary.errorSnippets = output.trim() ? output.split(/\r?\n/).filter(Boolean).slice(0, MAX_SNIPPETS) : [];
  return summary;
}

function parseRawOutput(output: string): ParsedSummary {
  return (
    parseTscOutput(output) ||
    parseNodeAssertionOutput(output) ||
    parseDevflowVerifyOutput(output) ||
    parseNpmScriptFailure(output) ||
    parseUnknownOutput(output)
  );
}

export function parseTestReport(state: AppState, args: Record<string, any>): ParseTestReportResult {
  const root = resolveProjectRoot(state, args);
  const maxBytes = clampBytes(args.maxBytes);
  const rawOutput = typeof args.rawOutput === 'string' ? args.rawOutput : '';
  const reportPathsInput = Array.isArray(args.reportPaths)
    ? args.reportPaths.filter((value): value is string => typeof value === 'string')
    : [];

  if (!rawOutput.trim() && reportPathsInput.length === 0) {
    throw createApiError(400, 'REPORT_INPUT_REQUIRED', 'rawOutput or reportPaths is required.');
  }

  const loadedReports = loadReportFiles(root, reportPathsInput);
  const combinedSource = [rawOutput, loadedReports.content].filter(Boolean).join('\n');
  const combinedOutput = truncateOutput(combinedSource, maxBytes);
  const parsed = parseRawOutput(combinedOutput.value);

  return {
    ...parsed,
    source: {
      usedRawOutput: Boolean(rawOutput),
      reportPaths: loadedReports.reportPaths,
    },
    truncated: combinedOutput.truncated,
    consumedBytes: combinedOutput.consumedBytes,
  };
}
