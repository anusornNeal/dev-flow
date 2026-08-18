import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export interface SourceDisclosureFixtureFile {
  path: string;
  lineCount: number;
  sourceBytes: number;
}

export interface SourceDisclosureFixture {
  id: 'onboarding' | 'job-detail';
  title: string;
  files: SourceDisclosureFixtureFile[];
  observedWallClockMs: {
    legacy: number;
    adaptive: number;
    note: string;
  };
}

export interface SourceDisclosureMetrics {
  logicalContentReadBoundaries: number;
  filesCovered: number;
  linesCovered: number;
  evidenceLinesCovered: number;
  evidenceCoverageRate: number;
  sourceBytesReturned: number;
  totalPayloadBytes: number;
  truncationCount: number;
  truncationRate: number;
  repeatedReadCount: number;
  elapsedLocalToolMs: number;
  observedEndToEndWallClockMs: number | null;
}

export interface SourceDisclosureGateResult {
  passed: boolean;
  boundaryReductionRate: number;
  totalPayloadBytesRatio: number;
  sourceBytesRatio: number;
  evidenceCoverageEquivalent: boolean;
  truncationDidNotRegress: boolean;
  checks: {
    boundaryReductionAtLeast50Percent: boolean;
    totalPayloadBytesAtMost120Percent: boolean;
    sourceBytesAtMost120Percent: boolean;
    evidenceCoverageEquivalent: boolean;
    truncationDidNotRegress: boolean;
  };
}

export interface SourceDisclosureScenarioComparison {
  fixtureId: SourceDisclosureFixture['id'];
  fixtureTitle: string;
  fileCount: number;
  lineCount: number;
  legacy: SourceDisclosureMetrics;
  adaptive: SourceDisclosureMetrics;
  gate: SourceDisclosureGateResult;
}

export interface SourceDisclosureThresholdComparison {
  thresholdLines: number;
  scenarios: SourceDisclosureScenarioComparison[];
  aggregate: {
    legacy: SourceDisclosureMetrics;
    adaptive: SourceDisclosureMetrics;
    gate: SourceDisclosureGateResult;
  };
}

export interface AdaptiveSourceDisclosureBenchmarkResult {
  schemaVersion: 1;
  benchmark: 'devflow-adaptive-source-disclosure';
  fixtureIdentity: 'representative-source-disclosure-v1';
  config: {
    legacyWindowLines: number;
    thresholds: number[];
  };
  fixtures: Array<{
    id: SourceDisclosureFixture['id'];
    title: string;
    fileCount: number;
    lineCount: number;
    sourceBytes: number;
    referenceObservedWallClockMs: SourceDisclosureFixture['observedWallClockMs'];
  }>;
  comparisons: SourceDisclosureThresholdComparison[];
  passed: boolean;
}

export interface RunAdaptiveSourceDisclosureBenchmarkOptions {
  legacyWindowLines?: number;
  thresholds?: number[];
  observedWallClockMs?: Partial<
    Record<SourceDisclosureFixture['id'], { legacy?: number | null; adaptive?: number | null }>
  >;
}

const DEFAULT_LEGACY_WINDOW_LINES = 60;
const DEFAULT_THRESHOLDS = [250, 350, 400, 500];
const FIXED_PAYLOAD_OVERHEAD_BYTES = 96;

export const REPRESENTATIVE_SOURCE_DISCLOSURE_FIXTURES: SourceDisclosureFixture[] = [
  {
    id: 'onboarding',
    title: 'Onboarding representative multi-file flow',
    files: [
      ['src/onboarding/bootstrap.ts', 237],
      ['src/onboarding/routes.ts', 35],
      ['src/onboarding/session.ts', 235],
      ['src/onboarding/types.ts', 34],
      ['src/onboarding/constants.ts', 22],
      ['src/onboarding/project.ts', 237],
      ['src/onboarding/context.ts', 122],
      ['src/onboarding/repository.ts', 184],
      ['src/onboarding/workspace.ts', 193],
      ['src/onboarding/policy.ts', 131],
      ['src/onboarding/orchestrator.ts', 277],
    ].map(([path, lineCount], index) => ({
      path: path as string,
      lineCount: lineCount as number,
      sourceBytes: (lineCount as number) * (82 + (index % 5) * 7),
    })),
    observedWallClockMs: {
      legacy: 4 * 60_000 + 23_000,
      adaptive: 1 * 60_000 + 31_000,
      note: 'Observed session reference only; never used as a CI pass/fail gate.',
    },
  },
  {
    id: 'job-detail',
    title: 'JobDetail representative multi-file flow',
    files: [
      ['src/job-detail/header.tsx', 64],
      ['src/job-detail/overview.tsx', 135],
      ['src/job-detail/activity.tsx', 70],
      ['src/job-detail/logs.tsx', 217],
      ['src/job-detail/actions.tsx', 105],
      ['src/job-detail/state.ts', 131],
      ['src/job-detail/types.ts', 27],
      ['src/job-detail/constants.ts', 28],
      ['src/job-detail/hooks.ts', 36],
      ['src/job-detail/formatters.ts', 69],
      ['src/job-detail/job-detail.tsx', 318],
    ].map(([path, lineCount], index) => ({
      path: path as string,
      lineCount: lineCount as number,
      sourceBytes: (lineCount as number) * (88 + (index % 4) * 6),
    })),
    observedWallClockMs: {
      legacy: 6 * 60_000 + 30_000,
      adaptive: 1 * 60_000 + 54_000,
      note: 'Less-controlled first-pass discovery observation; reporting reference only.',
    },
  },
];

function assertPositiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; received ${value}`);
  }
}

function bytesForLineRange(file: SourceDisclosureFixtureFile, startLine: number, endLine: number) {
  const before = Math.floor((file.sourceBytes * (startLine - 1)) / file.lineCount);
  const through = Math.floor((file.sourceBytes * endLine) / file.lineCount);
  return through - before;
}

function simulateStrategy(
  fixture: SourceDisclosureFixture,
  windowLines: number,
  observedEndToEndWallClockMs: number | null,
): SourceDisclosureMetrics {
  assertPositiveInteger(windowLines, 'windowLines');
  const startedAt = performance.now();

  let logicalContentReadBoundaries = 0;
  let linesCovered = 0;
  let sourceBytesReturned = 0;
  let totalPayloadBytes = 0;
  let truncationCount = 0;
  let repeatedReadCount = 0;

  for (const file of fixture.files) {
    let readIndex = 0;
    for (let startLine = 1; startLine <= file.lineCount; startLine += windowLines) {
      const endLine = Math.min(file.lineCount, startLine + windowLines - 1);
      const sourceBytes = bytesForLineRange(file, startLine, endLine);
      const metadataBytes = Buffer.byteLength(file.path, 'utf8')
        + Buffer.byteLength(`${startLine}:${endLine}:${file.lineCount}`, 'utf8')
        + FIXED_PAYLOAD_OVERHEAD_BYTES;

      logicalContentReadBoundaries += 1;
      linesCovered += endLine - startLine + 1;
      sourceBytesReturned += sourceBytes;
      totalPayloadBytes += sourceBytes + metadataBytes;
      if (endLine < file.lineCount) truncationCount += 1;
      if (readIndex > 0) repeatedReadCount += 1;
      readIndex += 1;
    }
  }

  const totalEvidenceLines = fixture.files.reduce((sum, file) => sum + file.lineCount, 0);
  const elapsedLocalToolMs = performance.now() - startedAt;

  return {
    logicalContentReadBoundaries,
    filesCovered: fixture.files.length,
    linesCovered,
    evidenceLinesCovered: linesCovered,
    evidenceCoverageRate: totalEvidenceLines === 0 ? 1 : linesCovered / totalEvidenceLines,
    sourceBytesReturned,
    totalPayloadBytes,
    truncationCount,
    truncationRate: logicalContentReadBoundaries === 0 ? 0 : truncationCount / logicalContentReadBoundaries,
    repeatedReadCount,
    elapsedLocalToolMs,
    observedEndToEndWallClockMs,
  };
}

function evaluateGate(legacy: SourceDisclosureMetrics, adaptive: SourceDisclosureMetrics): SourceDisclosureGateResult {
  const boundaryReductionRate = legacy.logicalContentReadBoundaries === 0
    ? 0
    : 1 - adaptive.logicalContentReadBoundaries / legacy.logicalContentReadBoundaries;
  const totalPayloadBytesRatio = legacy.totalPayloadBytes === 0
    ? 1
    : adaptive.totalPayloadBytes / legacy.totalPayloadBytes;
  const sourceBytesRatio = legacy.sourceBytesReturned === 0
    ? 1
    : adaptive.sourceBytesReturned / legacy.sourceBytesReturned;
  const evidenceCoverageEquivalent = adaptive.filesCovered === legacy.filesCovered
    && adaptive.linesCovered === legacy.linesCovered
    && adaptive.evidenceLinesCovered === legacy.evidenceLinesCovered
    && adaptive.evidenceCoverageRate >= legacy.evidenceCoverageRate;
  const truncationDidNotRegress = adaptive.truncationCount <= legacy.truncationCount
    && adaptive.truncationRate <= legacy.truncationRate;

  const checks = {
    boundaryReductionAtLeast50Percent: boundaryReductionRate >= 0.5,
    totalPayloadBytesAtMost120Percent: totalPayloadBytesRatio <= 1.2,
    sourceBytesAtMost120Percent: sourceBytesRatio <= 1.2,
    evidenceCoverageEquivalent,
    truncationDidNotRegress,
  };

  return {
    passed: Object.values(checks).every(Boolean),
    boundaryReductionRate,
    totalPayloadBytesRatio,
    sourceBytesRatio,
    evidenceCoverageEquivalent,
    truncationDidNotRegress,
    checks,
  };
}

function sumMetrics(metrics: SourceDisclosureMetrics[]): SourceDisclosureMetrics {
  const boundaries = metrics.reduce((sum, item) => sum + item.logicalContentReadBoundaries, 0);
  const truncations = metrics.reduce((sum, item) => sum + item.truncationCount, 0);
  const observedValues = metrics.map((item) => item.observedEndToEndWallClockMs);

  return {
    logicalContentReadBoundaries: boundaries,
    filesCovered: metrics.reduce((sum, item) => sum + item.filesCovered, 0),
    linesCovered: metrics.reduce((sum, item) => sum + item.linesCovered, 0),
    evidenceLinesCovered: metrics.reduce((sum, item) => sum + item.evidenceLinesCovered, 0),
    evidenceCoverageRate: metrics.length === 0
      ? 1
      : metrics.reduce((sum, item) => sum + item.evidenceCoverageRate, 0) / metrics.length,
    sourceBytesReturned: metrics.reduce((sum, item) => sum + item.sourceBytesReturned, 0),
    totalPayloadBytes: metrics.reduce((sum, item) => sum + item.totalPayloadBytes, 0),
    truncationCount: truncations,
    truncationRate: boundaries === 0 ? 0 : truncations / boundaries,
    repeatedReadCount: metrics.reduce((sum, item) => sum + item.repeatedReadCount, 0),
    elapsedLocalToolMs: metrics.reduce((sum, item) => sum + item.elapsedLocalToolMs, 0),
    observedEndToEndWallClockMs: observedValues.every((value) => typeof value === 'number')
      ? (observedValues as number[]).reduce((sum, value) => sum + value, 0)
      : null,
  };
}

function observedFor(
  fixture: SourceDisclosureFixture,
  strategy: 'legacy' | 'adaptive',
  overrides: RunAdaptiveSourceDisclosureBenchmarkOptions['observedWallClockMs'],
) {
  const override = overrides?.[fixture.id]?.[strategy];
  if (override !== undefined) return override;
  return fixture.observedWallClockMs[strategy];
}

export function runAdaptiveSourceDisclosureBenchmark(
  options: RunAdaptiveSourceDisclosureBenchmarkOptions = {},
): AdaptiveSourceDisclosureBenchmarkResult {
  const legacyWindowLines = options.legacyWindowLines ?? DEFAULT_LEGACY_WINDOW_LINES;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;

  assertPositiveInteger(legacyWindowLines, 'legacyWindowLines');
  if (thresholds.length === 0) throw new Error('At least one adaptive threshold is required.');
  thresholds.forEach((threshold, index) => assertPositiveInteger(threshold, `thresholds[${index}]`));

  const comparisons = thresholds.map<SourceDisclosureThresholdComparison>((thresholdLines) => {
    const scenarios = REPRESENTATIVE_SOURCE_DISCLOSURE_FIXTURES.map<SourceDisclosureScenarioComparison>((fixture) => {
      const legacy = simulateStrategy(
        fixture,
        legacyWindowLines,
        observedFor(fixture, 'legacy', options.observedWallClockMs),
      );
      const adaptive = simulateStrategy(
        fixture,
        thresholdLines,
        observedFor(fixture, 'adaptive', options.observedWallClockMs),
      );

      return {
        fixtureId: fixture.id,
        fixtureTitle: fixture.title,
        fileCount: fixture.files.length,
        lineCount: fixture.files.reduce((sum, file) => sum + file.lineCount, 0),
        legacy,
        adaptive,
        gate: evaluateGate(legacy, adaptive),
      };
    });

    const aggregateLegacy = sumMetrics(scenarios.map((scenario) => scenario.legacy));
    const aggregateAdaptive = sumMetrics(scenarios.map((scenario) => scenario.adaptive));

    return {
      thresholdLines,
      scenarios,
      aggregate: {
        legacy: aggregateLegacy,
        adaptive: aggregateAdaptive,
        gate: evaluateGate(aggregateLegacy, aggregateAdaptive),
      },
    };
  });

  return {
    schemaVersion: 1,
    benchmark: 'devflow-adaptive-source-disclosure',
    fixtureIdentity: 'representative-source-disclosure-v1',
    config: {
      legacyWindowLines,
      thresholds: [...thresholds],
    },
    fixtures: REPRESENTATIVE_SOURCE_DISCLOSURE_FIXTURES.map((fixture) => ({
      id: fixture.id,
      title: fixture.title,
      fileCount: fixture.files.length,
      lineCount: fixture.files.reduce((sum, file) => sum + file.lineCount, 0),
      sourceBytes: fixture.files.reduce((sum, file) => sum + file.sourceBytes, 0),
      referenceObservedWallClockMs: fixture.observedWallClockMs,
    })),
    comparisons,
    passed: comparisons.every((comparison) => comparison.aggregate.gate.passed),
  };
}

function parseThresholds(raw: string | undefined) {
  if (!raw) return undefined;
  return raw.split(',').map((value) => Number.parseInt(value.trim(), 10));
}

function parseCliArgs(argv: string[]) {
  let thresholds: number[] | undefined;
  let legacyWindowLines: number | undefined;
  let pretty = false;

  for (const arg of argv) {
    if (arg.startsWith('--thresholds=')) thresholds = parseThresholds(arg.slice('--thresholds='.length));
    else if (arg.startsWith('--legacy-window=')) legacyWindowLines = Number.parseInt(arg.slice('--legacy-window='.length), 10);
    else if (arg === '--pretty') pretty = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return { thresholds, legacyWindowLines, pretty };
}

function main() {
  const { thresholds, legacyWindowLines, pretty } = parseCliArgs(process.argv.slice(2));
  const result = runAdaptiveSourceDisclosureBenchmark({ thresholds, legacyWindowLines });
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
