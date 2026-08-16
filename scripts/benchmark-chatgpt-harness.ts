import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export type HarnessCorpus = 'calibration' | 'holdout';
export type HarnessTerminalOutcome = 'success' | 'blocked' | 'failed';
export type RegressionClass = 'improvement' | 'regression' | 'unchanged';

type JsonScalar = string | number | boolean | null;
type JsonRecord = Record<string, JsonScalar>;

export interface HarnessTrajectoryEvent {
  kind: 'tool' | 'evidence' | 'verification' | 'retry' | 'repair' | 'resume' | 'decision' | 'terminal';
  name: string;
  status?: 'ok' | 'passed' | 'failed' | 'blocked';
  payloadBytes?: number;
  contextBytes?: number;
  observedWallClockMs?: number;
  modelTokens?: number;
  lifecycleStage?: string;
  policyDecision?: JsonRecord;
  contextDecision?: JsonRecord;
  evidenceId?: string;
}

export interface HarnessStrategyFixture {
  strategyVersion: string;
  policyVersion: string;
  terminalOutcome: HarnessTerminalOutcome;
  events: HarnessTrajectoryEvent[];
}

export interface HarnessScenario {
  schemaVersion: 1;
  id: string;
  corpus: HarnessCorpus;
  title: string;
  task: {
    category: string;
    risk: 'low' | 'medium' | 'high';
    facts: JsonRecord;
  };
  oracle: {
    terminalOutcome: HarnessTerminalOutcome;
    expectedLifecycleStages?: string[];
    expectedPolicyDecision?: JsonRecord;
    expectedContextDecision?: JsonRecord;
    limits?: {
      maxRepairCount?: number;
      maxToolCallCount?: number;
      maxContextBytes?: number;
      maxRetryCount?: number;
      maxVerificationFailures?: number;
    };
  };
  strategies: Record<string, HarnessStrategyFixture>;
}

export interface HarnessOwnedMetrics {
  oraclePassed: boolean;
  firstPassSuccess: boolean;
  repairCount: number;
  toolCallCount: number;
  contextBytes: number;
  retryCount: number;
  verificationFailures: number;
  observedWallClockMs: number;
  modelTokenCount?: number;
}

export interface HarnessScenarioResult {
  scenarioId: string;
  corpus: HarnessCorpus;
  title: string;
  strategyName: string;
  strategyVersion: string;
  policyVersion: string;
  repoFingerprint: string;
  environmentFingerprint: string;
  terminalOutcome: HarnessTerminalOutcome;
  lifecycleStages: string[];
  policyDecision: JsonRecord;
  contextDecision: JsonRecord;
  metrics: HarnessOwnedMetrics;
  oracleFailures: string[];
  trajectory: HarnessTrajectoryEvent[];
}

export interface HarnessRunResult {
  schemaVersion: 1;
  benchmark: 'devflow-chatgpt-harness-golden';
  corpusIdentity: string;
  strategyName: string;
  repoFingerprint: string;
  environmentFingerprint: string;
  scenarios: HarnessScenarioResult[];
  aggregate: HarnessAggregateMetrics;
}

export interface HarnessAggregateMetrics {
  scenarioCount: number;
  oraclePassCount: number;
  oraclePassRate: number;
  firstPassSuccessCount: number;
  repairCount: number;
  toolCallCount: number;
  contextBytes: number;
  retryCount: number;
  verificationFailures: number;
  observedWallClockMs: number;
  modelTokenCount?: number;
  strategyVersions: string[];
  policyVersions: string[];
}

export interface HarnessMetricComparison {
  baseline: number;
  candidate: number;
  delta: number;
  classification: RegressionClass;
}

export interface HarnessCorpusComparison {
  corpus: HarnessCorpus;
  scenarioIds: string[];
  metrics: Record<string, HarnessMetricComparison>;
  classification: RegressionClass;
}

export interface HarnessBenchmarkResult {
  schemaVersion: 1;
  benchmark: 'devflow-chatgpt-harness-golden-comparison';
  repoFingerprint: string;
  environmentFingerprint: string;
  baselineStrategy: string;
  candidateStrategy: string;
  corpusIdentity: string;
  corpora: HarnessCorpusComparison[];
  classification: RegressionClass;
  raw: {
    baseline: HarnessRunResult;
    candidate: HarnessRunResult;
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function assertFiniteNonNegative(value: unknown, field: string) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number.`);
  }
}

function assertJsonRecord(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!['string', 'number', 'boolean'].includes(typeof entry) && entry !== null) {
      throw new Error(`${field}.${key} must be a JSON scalar.`);
    }
  }
}

export function validateHarnessScenario(value: unknown): asserts value is HarnessScenario {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Harness scenario must be an object.');
  const scenario = value as Partial<HarnessScenario>;
  if (scenario.schemaVersion !== 1) throw new Error('Harness scenario schemaVersion must be 1.');
  if (!scenario.id || typeof scenario.id !== 'string') throw new Error('Harness scenario id is required.');
  if (scenario.corpus !== 'calibration' && scenario.corpus !== 'holdout') throw new Error(`${scenario.id}: invalid corpus.`);
  if (!scenario.title || typeof scenario.title !== 'string') throw new Error(`${scenario.id}: title is required.`);
  if (!scenario.task || typeof scenario.task !== 'object') throw new Error(`${scenario.id}: task is required.`);
  if (!scenario.oracle || typeof scenario.oracle !== 'object') throw new Error(`${scenario.id}: oracle is required.`);
  if (!scenario.strategies || typeof scenario.strategies !== 'object') throw new Error(`${scenario.id}: strategies are required.`);
  if (!['success', 'blocked', 'failed'].includes(scenario.oracle.terminalOutcome)) throw new Error(`${scenario.id}: invalid oracle terminalOutcome.`);
  assertJsonRecord(scenario.task.facts, `${scenario.id}.task.facts`);
  if (scenario.oracle.expectedPolicyDecision) assertJsonRecord(scenario.oracle.expectedPolicyDecision, `${scenario.id}.oracle.expectedPolicyDecision`);
  if (scenario.oracle.expectedContextDecision) assertJsonRecord(scenario.oracle.expectedContextDecision, `${scenario.id}.oracle.expectedContextDecision`);

  for (const [strategyName, strategy] of Object.entries(scenario.strategies)) {
    if (!strategy || typeof strategy !== 'object') throw new Error(`${scenario.id}.${strategyName}: strategy must be an object.`);
    if (!strategy.strategyVersion || !strategy.policyVersion) throw new Error(`${scenario.id}.${strategyName}: strategy/policy version are required.`);
    if (!['success', 'blocked', 'failed'].includes(strategy.terminalOutcome)) throw new Error(`${scenario.id}.${strategyName}: invalid terminalOutcome.`);
    if (!Array.isArray(strategy.events)) throw new Error(`${scenario.id}.${strategyName}: events must be an array.`);
    strategy.events.forEach((event, index) => {
      if (!event || typeof event !== 'object' || !event.kind || !event.name) throw new Error(`${scenario.id}.${strategyName}.events[${index}] is invalid.`);
      assertFiniteNonNegative(event.payloadBytes, `${scenario.id}.${strategyName}.events[${index}].payloadBytes`);
      assertFiniteNonNegative(event.contextBytes, `${scenario.id}.${strategyName}.events[${index}].contextBytes`);
      assertFiniteNonNegative(event.observedWallClockMs, `${scenario.id}.${strategyName}.events[${index}].observedWallClockMs`);
      assertFiniteNonNegative(event.modelTokens, `${scenario.id}.${strategyName}.events[${index}].modelTokens`);
      if (event.policyDecision) assertJsonRecord(event.policyDecision, `${scenario.id}.${strategyName}.events[${index}].policyDecision`);
      if (event.contextDecision) assertJsonRecord(event.contextDecision, `${scenario.id}.${strategyName}.events[${index}].contextDecision`);
    });
  }
}

export function loadHarnessScenarios(fixturesDir = path.resolve('tests/fixtures/harness-evals')): HarnessScenario[] {
  const entries = fs.readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const scenarios: HarnessScenario[] = [];
  for (const entry of entries) {
    const parsed = JSON.parse(fs.readFileSync(path.join(fixturesDir, entry.name), 'utf8')) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    for (const value of values) {
      validateHarnessScenario(value);
      scenarios.push(value);
    }
  }
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate harness scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return scenarios.sort((left, right) => left.id.localeCompare(right.id));
}

function readLatestDecision(events: HarnessTrajectoryEvent[], key: 'policyDecision' | 'contextDecision'): JsonRecord {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const decision = events[index][key];
    if (decision) return { ...decision };
  }
  return {};
}

function collectLifecycleStages(events: HarnessTrajectoryEvent[]): string[] {
  const stages: string[] = [];
  for (const event of events) {
    if (event.lifecycleStage && stages.at(-1) !== event.lifecycleStage) stages.push(event.lifecycleStage);
  }
  return stages;
}

function recordMatches(actual: JsonRecord, expected: JsonRecord): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function evaluateScenario(scenario: HarnessScenario, strategyName: string, strategy: HarnessStrategyFixture) {
  const events = strategy.events;
  const lifecycleStages = collectLifecycleStages(events);
  const policyDecision = readLatestDecision(events, 'policyDecision');
  const contextDecision = readLatestDecision(events, 'contextDecision');
  const repairCount = events.filter((event) => event.kind === 'repair').length;
  const toolCallCount = events.filter((event) => event.kind === 'tool').length;
  const contextBytes = events.reduce((sum, event) => sum + (event.contextBytes ?? 0), 0);
  const retryCount = events.filter((event) => event.kind === 'retry').length;
  const verificationFailures = events.filter((event) => event.kind === 'verification' && event.status === 'failed').length;
  const observedWallClockMs = events.reduce((sum, event) => sum + (event.observedWallClockMs ?? 0), 0);
  const tokenSamples = events.map((event) => event.modelTokens).filter((value): value is number => typeof value === 'number');
  const oracleFailures: string[] = [];

  if (strategy.terminalOutcome !== scenario.oracle.terminalOutcome) {
    oracleFailures.push(`terminalOutcome expected ${scenario.oracle.terminalOutcome} but got ${strategy.terminalOutcome}`);
  }
  if (scenario.oracle.expectedLifecycleStages && stableJson(lifecycleStages) !== stableJson(scenario.oracle.expectedLifecycleStages)) {
    oracleFailures.push(`lifecycle stages did not match oracle`);
  }
  if (scenario.oracle.expectedPolicyDecision && !recordMatches(policyDecision, scenario.oracle.expectedPolicyDecision)) {
    oracleFailures.push(`policy decision did not match oracle`);
  }
  if (scenario.oracle.expectedContextDecision && !recordMatches(contextDecision, scenario.oracle.expectedContextDecision)) {
    oracleFailures.push(`context decision did not match oracle`);
  }

  const limits = scenario.oracle.limits ?? {};
  const boundedMetrics: Array<[keyof typeof limits, number]> = [
    ['maxRepairCount', repairCount],
    ['maxToolCallCount', toolCallCount],
    ['maxContextBytes', contextBytes],
    ['maxRetryCount', retryCount],
    ['maxVerificationFailures', verificationFailures],
  ];
  for (const [key, actual] of boundedMetrics) {
    const limit = limits[key];
    if (typeof limit === 'number' && actual > limit) oracleFailures.push(`${key} exceeded: ${actual} > ${limit}`);
  }

  const metrics: HarnessOwnedMetrics = {
    oraclePassed: oracleFailures.length === 0,
    firstPassSuccess: oracleFailures.length === 0 && repairCount === 0 && verificationFailures === 0,
    repairCount,
    toolCallCount,
    contextBytes,
    retryCount,
    verificationFailures,
    observedWallClockMs,
    ...(tokenSamples.length > 0 ? { modelTokenCount: tokenSamples.reduce((sum, value) => sum + value, 0) } : {}),
  };

  return { lifecycleStages, policyDecision, contextDecision, metrics, oracleFailures };
}

function aggregateResults(results: HarnessScenarioResult[]): HarnessAggregateMetrics {
  const modelTokenSamples = results.map((result) => result.metrics.modelTokenCount).filter((value): value is number => typeof value === 'number');
  return {
    scenarioCount: results.length,
    oraclePassCount: results.filter((result) => result.metrics.oraclePassed).length,
    oraclePassRate: results.length === 0 ? 0 : results.filter((result) => result.metrics.oraclePassed).length / results.length,
    firstPassSuccessCount: results.filter((result) => result.metrics.firstPassSuccess).length,
    repairCount: results.reduce((sum, result) => sum + result.metrics.repairCount, 0),
    toolCallCount: results.reduce((sum, result) => sum + result.metrics.toolCallCount, 0),
    contextBytes: results.reduce((sum, result) => sum + result.metrics.contextBytes, 0),
    retryCount: results.reduce((sum, result) => sum + result.metrics.retryCount, 0),
    verificationFailures: results.reduce((sum, result) => sum + result.metrics.verificationFailures, 0),
    observedWallClockMs: results.reduce((sum, result) => sum + result.metrics.observedWallClockMs, 0),
    ...(modelTokenSamples.length > 0 ? { modelTokenCount: modelTokenSamples.reduce((sum, value) => sum + value, 0) } : {}),
    strategyVersions: [...new Set(results.map((result) => result.strategyVersion))].sort(),
    policyVersions: [...new Set(results.map((result) => result.policyVersion))].sort(),
  };
}

export function defaultRepoFingerprint(root = process.cwd()): string {
  let head = 'unknown';
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
  } catch {
    // Offline/local evaluation remains valid even when Git metadata is unavailable.
  }
  let packageVersion = 'unknown';
  try {
    packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    // Fingerprint still captures the available local revision facts.
  }
  return sha256({ head, packageVersion });
}

export function defaultEnvironmentFingerprint(): string {
  const nodeMajor = process.versions.node.split('.')[0];
  return sha256({ platform: process.platform, arch: process.arch, nodeMajor });
}

export function runHarnessEval(options: {
  scenarios: HarnessScenario[];
  strategyName: string;
  repoFingerprint?: string;
  environmentFingerprint?: string;
}): HarnessRunResult {
  const repoFingerprint = options.repoFingerprint ?? defaultRepoFingerprint();
  const environmentFingerprint = options.environmentFingerprint ?? defaultEnvironmentFingerprint();
  const results = options.scenarios.map((scenario): HarnessScenarioResult => {
    const strategy = scenario.strategies[options.strategyName];
    if (!strategy) throw new Error(`${scenario.id}: missing strategy '${options.strategyName}'.`);
    const evaluated = evaluateScenario(scenario, options.strategyName, strategy);
    return {
      scenarioId: scenario.id,
      corpus: scenario.corpus,
      title: scenario.title,
      strategyName: options.strategyName,
      strategyVersion: strategy.strategyVersion,
      policyVersion: strategy.policyVersion,
      repoFingerprint,
      environmentFingerprint,
      terminalOutcome: strategy.terminalOutcome,
      lifecycleStages: evaluated.lifecycleStages,
      policyDecision: evaluated.policyDecision,
      contextDecision: evaluated.contextDecision,
      metrics: evaluated.metrics,
      oracleFailures: evaluated.oracleFailures,
      trajectory: strategy.events.map((event) => ({ ...event })),
    };
  }).sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));

  return {
    schemaVersion: 1,
    benchmark: 'devflow-chatgpt-harness-golden',
    corpusIdentity: sha256(options.scenarios.map((scenario) => ({ id: scenario.id, corpus: scenario.corpus, schemaVersion: scenario.schemaVersion }))),
    strategyName: options.strategyName,
    repoFingerprint,
    environmentFingerprint,
    scenarios: results,
    aggregate: aggregateResults(results),
  };
}

const LOWER_IS_BETTER = new Set(['repairCount', 'toolCallCount', 'contextBytes', 'retryCount', 'verificationFailures']);
const HIGHER_IS_BETTER = new Set(['oraclePassRate', 'firstPassSuccessCount']);

function classifyMetric(metric: string, baseline: number, candidate: number): RegressionClass {
  if (baseline === candidate) return 'unchanged';
  if (LOWER_IS_BETTER.has(metric)) return candidate < baseline ? 'improvement' : 'regression';
  if (HIGHER_IS_BETTER.has(metric)) return candidate > baseline ? 'improvement' : 'regression';
  return 'unchanged';
}

function classificationFromMetrics(metrics: Record<string, HarnessMetricComparison>): RegressionClass {
  const values = Object.values(metrics).map((metric) => metric.classification);
  if (values.includes('regression')) return 'regression';
  if (values.includes('improvement')) return 'improvement';
  return 'unchanged';
}

function aggregateForCorpus(run: HarnessRunResult, corpus: HarnessCorpus): HarnessAggregateMetrics {
  return aggregateResults(run.scenarios.filter((scenario) => scenario.corpus === corpus));
}

export function compareHarnessRuns(baseline: HarnessRunResult, candidate: HarnessRunResult): HarnessBenchmarkResult {
  if (baseline.corpusIdentity !== candidate.corpusIdentity) throw new Error('Cannot compare harness runs from different scenario corpora.');
  if (baseline.repoFingerprint !== candidate.repoFingerprint) throw new Error('Cannot compare harness runs from different repo fingerprints.');
  if (baseline.environmentFingerprint !== candidate.environmentFingerprint) throw new Error('Cannot compare harness runs from different environment fingerprints.');
  const corpora: HarnessCorpusComparison[] = (['calibration', 'holdout'] as const).map((corpus) => {
    const baselineAggregate = aggregateForCorpus(baseline, corpus);
    const candidateAggregate = aggregateForCorpus(candidate, corpus);
    const metricNames = ['oraclePassRate', 'firstPassSuccessCount', 'repairCount', 'toolCallCount', 'contextBytes', 'retryCount', 'verificationFailures'] as const;
    const metrics: Record<string, HarnessMetricComparison> = {};
    for (const metric of metricNames) {
      const baselineValue = baselineAggregate[metric] as number;
      const candidateValue = candidateAggregate[metric] as number;
      metrics[metric] = {
        baseline: baselineValue,
        candidate: candidateValue,
        delta: candidateValue - baselineValue,
        classification: classifyMetric(metric, baselineValue, candidateValue),
      };
    }
    return {
      corpus,
      scenarioIds: baseline.scenarios.filter((scenario) => scenario.corpus === corpus).map((scenario) => scenario.scenarioId).sort(),
      metrics,
      classification: classificationFromMetrics(metrics),
    };
  });

  const holdout = corpora.find((entry) => entry.corpus === 'holdout')!;
  const calibration = corpora.find((entry) => entry.corpus === 'calibration')!;
  const classification = holdout.classification === 'regression'
    ? 'regression'
    : holdout.classification === 'improvement'
      ? 'improvement'
      : calibration.classification;

  return {
    schemaVersion: 1,
    benchmark: 'devflow-chatgpt-harness-golden-comparison',
    repoFingerprint: baseline.repoFingerprint,
    environmentFingerprint: baseline.environmentFingerprint,
    baselineStrategy: baseline.strategyName,
    candidateStrategy: candidate.strategyName,
    corpusIdentity: baseline.corpusIdentity,
    corpora,
    classification,
    raw: { baseline, candidate },
  };
}

export function runHarnessBenchmark(options: {
  fixturesDir?: string;
  baselineStrategy?: string;
  candidateStrategy?: string;
  repoFingerprint?: string;
  environmentFingerprint?: string;
} = {}): HarnessBenchmarkResult {
  const scenarios = loadHarnessScenarios(options.fixturesDir);
  const repoFingerprint = options.repoFingerprint ?? defaultRepoFingerprint();
  const environmentFingerprint = options.environmentFingerprint ?? defaultEnvironmentFingerprint();
  const baseline = runHarnessEval({
    scenarios,
    strategyName: options.baselineStrategy ?? 'baseline',
    repoFingerprint,
    environmentFingerprint,
  });
  const candidate = runHarnessEval({
    scenarios,
    strategyName: options.candidateStrategy ?? 'candidate',
    repoFingerprint,
    environmentFingerprint,
  });
  return compareHarnessRuns(baseline, candidate);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const fixturesDir = readArg('--fixtures');
  const baselineStrategy = readArg('--baseline');
  const candidateStrategy = readArg('--candidate');
  const outputPath = readArg('--output');
  const result = runHarnessBenchmark({ fixturesDir, baselineStrategy, candidateStrategy });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, json, 'utf8');
  }
  process.stdout.write(json);
  if (result.raw.baseline.aggregate.oraclePassCount !== result.raw.baseline.aggregate.scenarioCount
    || result.raw.candidate.aggregate.oraclePassCount !== result.raw.candidate.aggregate.scenarioCount
    || result.classification === 'regression') {
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryUrl === import.meta.url) main();
