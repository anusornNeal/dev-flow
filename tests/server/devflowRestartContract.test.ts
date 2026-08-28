import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVFLOW_CONTRACT_VERSION, getCapabilityCatalog } from '../../src/server/contracts/devflowContract.js';

test('capability catalog exposes guarded runtime restart tools', () => {
  const catalog = getCapabilityCatalog() as any;
  const restartTool = catalog.tools.find((tool: any) => tool.name === 'restart_devflow');
  const statusTool = catalog.tools.find((tool: any) => tool.name === 'get_devflow_restart_status');

  assert.ok(restartTool, 'restart_devflow should be exposed');
  assert.ok(statusTool, 'get_devflow_restart_status should be exposed');
  assert.match(restartTool.description, /API runtime only/i);
  assert.match(restartTool.description, /OpenAI Tunnel/i);
  assert.match(restartTool.description, /remain running/i);
  assert.match(statusTool.description, /after reconnecting/i);
  assert.match(statusTool.description, /preserved external-transport policy/i);
  assert.equal(catalog.matrix.runtime?.restart, true);
  assert.equal(catalog.matrix.runtime?.restartStatus, true);
  assert.equal(catalog.contractVersion, DEVFLOW_CONTRACT_VERSION);
});
