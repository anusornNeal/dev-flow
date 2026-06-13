import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDevFlowMcpServer } from './src/server/mcp.ts';

const apiBaseUrl = process.env.DEVFLOW_API_BASE_URL || 'http://127.0.0.1:3000';

async function main() {
  const server = createDevFlowMcpServer(apiBaseUrl);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`DevFlow MCP Server running on stdio via ${apiBaseUrl}`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
