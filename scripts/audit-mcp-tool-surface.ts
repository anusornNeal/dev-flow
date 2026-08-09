import { devFlowToolDefinitions, getMcpConsolidationReplacement, getMcpToolList, getToolProfileSummary } from '../src/server/contracts/devflowContract.js';
import { buildMcpToolSurfaceInventory, summarizeMcpToolSurfaceInventory } from '../src/server/contracts/mcpToolSurfaceClassification.js';

const inventory = buildMcpToolSurfaceInventory(devFlowToolDefinitions);
const summary = summarizeMcpToolSurfaceInventory(inventory);
const full = getMcpToolList('full');
const aliases = inventory.filter((item) => item.alias);

const fullNames = new Set(full.map((tool) => tool.name));
if (full.some((tool) => !inventory.some((item) => item.name === tool.name))) {
  throw new Error('Full MCP surface contains a tool missing from the backend inventory.');
}

const includeInventory = process.argv.includes('--full');

const report = {
  generatedAt: new Date().toISOString(),
  canonicalDefinitions: devFlowToolDefinitions.length,
  exposedFullTools: full.length,
  backendAliasCount: aliases.length,
  exposedAliasCount: full.filter((tool) => aliases.some((alias) => alias.name === tool.name)).length,
  profileSummary: getToolProfileSummary(),
  summary,
  consolidation: {
    hiddenBackendTools: inventory
      .filter((item) => !item.alias && !fullNames.has(item.name) && getMcpConsolidationReplacement(item.name))
      .map((item) => ({ name: item.name, replacement: getMcpConsolidationReplacement(item.name), risk: item.risk })),
    remainingMigrationCandidates: inventory
      .filter((item) => fullNames.has(item.name) && item.disposition === 'combine')
      .map((item) => ({ name: item.name, target: item.target, risk: item.risk })),
  },
  ...(includeInventory ? { inventory } : {}),
};

console.log(JSON.stringify(report, null, 2));
