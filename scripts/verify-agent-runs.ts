import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentRunHistoryPaths } from '../src/server/services/agentRunService';
import { LEGACY_AGENT_LAUNCH_RETIRED } from '../src/server/services/agentLaunchConfig';
import { LEGACY_RUNNER_RETIRED_MESSAGE } from '../src/runner';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceSource = fs.readFileSync(path.join(root, 'src/server/services/agentRunService.ts'), 'utf8');
const repositorySource = fs.readFileSync(path.join(root, 'src/server/repositories/agentRunRepository.ts'), 'utf8');
const runnerSource = fs.readFileSync(path.join(root, 'src/runner.ts'), 'utf8');
const triggerSource = fs.readFileSync(path.join(root, 'scripts/trigger-agent.bat'), 'utf8');

assert.equal(LEGACY_AGENT_LAUNCH_RETIRED, true);
assert.match(LEGACY_RUNNER_RETIRED_MESSAGE, /retired/i);
assert.match(triggerSource, /retired/i);
assert.doesNotMatch(triggerSource, /tsx\s+.*runner\.ts/i);

for (const retiredSymbol of [
  'buildAgentTriggerInvocation',
  'createAgentRunFiles',
  'writeAgentRunLaunchMetadata',
  'writeAgentRunOutputSummary',
  'writeAgentRunResult',
  'resolveAgentExecutionMode',
]) {
  assert.equal(serviceSource.includes(`function ${retiredSymbol}`), false, `${retiredSymbol} must remain retired`);
}
for (const retiredSymbol of ['createAgentRun', 'updateAgentRunStatus', 'cancelActiveRunsForTask', 'cancelStaleActiveRuns']) {
  assert.equal(repositorySource.includes(`function ${retiredSymbol}`), false, `${retiredSymbol} must remain retired`);
}
assert.doesNotMatch(runnerSource, /spawn\s*\(/);
assert.doesNotMatch(runnerSource, /buildAgentLaunchConfig/);

const history = getAgentRunHistoryPaths(path.join(root, '.devflow', 'runs', 'historic-run'));
assert.equal(history.promptPath, path.join(history.runDir, 'prompt.md'));
assert.equal(history.logPath, path.join(history.runDir, 'agent.log'));
assert.equal(history.launchMetadataPath, path.join(history.runDir, 'launch.json'));
assert.equal(history.outputSummaryPath, path.join(history.runDir, 'summary.txt'));
assert.equal(history.resultPath, path.join(history.runDir, 'result.json'));

console.log('[verify-agent-runs] legacy launcher retired; cold history remains readable');
