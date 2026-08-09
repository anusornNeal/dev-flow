import { devFlowToolDefinitions, getMcpToolList, getToolProfileSummary } from '../src/server/contracts/devflowContract.js';
import { buildMcpToolSurfaceInventory, summarizeMcpToolSurfaceInventory } from '../src/server/contracts/mcpToolSurfaceClassification.js';

const inventory = buildMcpToolSurfaceInventory(devFlowToolDefinitions);
const summary = summarizeMcpToolSurfaceInventory(inventory);
const full = getMcpToolList('full');
const aliases = inventory.filter((item) => item.alias);

if (inventory.length !== full.length) {
  throw new Error(`Inventory count ${inventory.length} does not match full MCP surface ${full.length}.`);
}

const includeInventory = process.argv.includes('--full');

const report = {
  generatedAt: new Date().toISOString(),
  canonicalDefinitions: devFlowToolDefinitions.length,
  exposedFullTools: full.length,
  aliasCount: aliases.length,
  profileSummary: getToolProfileSummary(),
  summary,
  migrationCandidates: {
    combine: inventory.filter((item) => item.disposition === 'combine').map((item) => ({ name: item.name, target: item.target, risk: item.risk })),
    hideDefault: inventory.filter((item) => item.disposition === 'hide-default').map((item) => ({ name: item.name, target: item.target, risk: item.risk })),
    deprecate: inventory.filter((item) => item.disposition === 'deprecate').map((item) => ({ name: item.name, target: item.target, risk: item.risk })),
  },
  ...(includeInventory ? { inventory } : {}),
};

console.log(JSON.stringify(report, null, 2));
