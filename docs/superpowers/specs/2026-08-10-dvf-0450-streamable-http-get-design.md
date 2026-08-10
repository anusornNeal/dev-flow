# DVF-0450 Streamable HTTP GET Design

## Goal

Stop normal Streamable HTTP lifecycle GET requests from falling through to Express 404 while preserving stateful POST session reuse, stale-session semantics, telemetry, and the legacy `/sse` transport.

## Evidence

The installed `@modelcontextprotocol/sdk` client starts a standalone GET SSE stream after the `notifications/initialized` POST is accepted. Its client treats HTTP 405 as a valid “GET streaming unsupported” response but treats other errors, including 404, as transport errors. The installed server transport explicitly handles GET and creates a standalone `text/event-stream` response after validating the MCP session and protocol version.

DevFlow currently mounts only `app.post('/mcp', ...)`, so GET never reaches `createReusableMcpHttpHandler`. That wrapper also currently rejects every non-POST request before the SDK transport can handle GET.

## Design

Use the SDK-supported GET path rather than intentionally disabling it.

- Mount one tracked `/mcp` handler for all HTTP methods after the existing timing and JSON middleware.
- `createReusableMcpHttpHandler` accepts POST and GET. Other methods return 405 with `Allow: GET, POST`.
- POST without a session remains the only operation that may create a new MCP session.
- GET requires an existing `mcp-session-id`; missing session identity returns 400 because DevFlow cannot select a stateful transport without it.
- GET with a genuine stale/unknown session ID returns 404, preserving the protocol signal for missing sessions.
- GET with a valid session delegates to that session’s `StreamableHTTPServerTransport.handleRequest`, which owns Accept/protocol-version validation and SSE behavior.
- Existing POST initialize/tools/list/tools/call and 202 notification handling continue through the same session transport.
- Legacy `/sse` routes are untouched.

## Telemetry

The same server route wrapper creates and completes `mcpTransport` tracking for GET and POST. GET has no JSON-RPC body, so it is intentionally classified as the existing bounded `other` operation. No request payloads or headers are retained.

## Verification

Regression coverage will prove:

1. production routing no longer exposes POST-only `/mcp`;
2. a valid initialized session can open a GET SSE stream with HTTP 200 and `text/event-stream`;
3. stale GET session IDs still return 404;
4. unsupported methods return 405 with `Allow: GET, POST`;
5. transport monitoring records GET as `other` without payload retention;
6. existing Streamable HTTP session reuse tests, transport monitor tests, typecheck, MCP transport benchmark/regression, and full verification stay green.

## Scope

No changes to legacy `/sse`, session storage architecture, authentication, payload logging, or concurrency policy.