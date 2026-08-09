import assert from 'node:assert/strict';

const previousProfile = process.env.DEVFLOW_MCP_TOOL_PROFILE;
process.env.DEVFLOW_MCP_TOOL_PROFILE = 'coding';

try {
  const { createDevFlowMcpServer } = await import('../src/server/mcp.js');
  const server = createDevFlowMcpServer('http://127.0.0.1:39999');
  const handlers = (server as any)._requestHandlers;
  const listHandler = handlers.get('tools/list');
  const callHandler = handlers.get('tools/call');
  assert.ok(listHandler);
  assert.ok(callHandler);

  const listed = await listHandler({ method: 'tools/list', params: {} });
  const names = new Set((listed.tools || []).map((tool: any) => tool.name));
  assert.equal(names.size, 48);
  for (const required of ['get_skill_router', 'create_task', 'get_repo_context_bundle', 'prepare_compact_edit', 'run_project_command', 'commit_git_changes', 'prepare_session_workspace']) {
    assert.equal(names.has(required), true, `fresh lean MCP connection should expose ${required}`);
  }
  assert.equal(names.has('get_figma_file'), false);
  assert.equal(names.has('get_task_prompt'), false);

  const hidden = await callHandler({ method: 'tools/call', params: { name: 'get_figma_file', arguments: { fileKey: 'fixture' } } });
  assert.equal(hidden.isError, true);
  const hiddenPayload = JSON.parse(hidden.content[0].text);
  assert.equal(hiddenPayload.code, 'TOOL_PROFILE_MISMATCH');
  assert.equal(hiddenPayload.details.activeProfile, 'coding');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    assert.equal(url.endsWith('/api/skills/authoring/00-skill-router'), true);
    return new Response(JSON.stringify({ id: '00-skill-router', content: '# lean router' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const allowed = await callHandler({ method: 'tools/call', params: { name: 'get_skill_router', arguments: {} } });
    assert.equal(allowed.isError, undefined);
    const payload = JSON.parse(allowed.content[0].text);
    assert.equal(payload.id, '00-skill-router');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(JSON.stringify({
    activeProfile: 'coding',
    listedTools: names.size,
    representativeToolsReady: true,
    hiddenCompatibilityToolRejected: true,
    allowedToolInvocationSucceeded: true,
  }, null, 2));
} finally {
  if (previousProfile === undefined) delete process.env.DEVFLOW_MCP_TOOL_PROFILE;
  else process.env.DEVFLOW_MCP_TOOL_PROFILE = previousProfile;
}
