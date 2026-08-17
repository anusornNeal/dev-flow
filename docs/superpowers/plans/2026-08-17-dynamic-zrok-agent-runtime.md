# Dynamic zrok Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DevFlow use the live local zrok Agent share as its account-neutral source of truth, dynamically discover the public MCP endpoint, and suppress unsafe takeover when Agent remoting is unsupported.

**Architecture:** Add a focused loopback Agent-console client and inject its sanitized status into `zrokRuntimeService`. Keep controller/account discovery only for optional remote diagnostics, make bootstrap treat explicit remoting HTTP 501 as a capability limitation, let the supervisor follow live endpoint changes, and make the React panel honor the structured actionability contract.

**Tech Stack:** TypeScript 5.8, Node.js fetch, React 19, Node test runner, PowerShell verification scripts.

## Global Constraints

- Never hard-code a zrok account, reserved name, public host, or provider domain.
- Never persist or expose zrok account/share tokens.
- Accept only loopback Agent-console addresses and bound all discovery and response handling.
- Preserve the existing `LocalSystem` service model and unrelated dirty changes.
- Fail closed for every ownership-changing operation.

---

### Task 1: Bounded local zrok Agent console client

**Files:**
- Create: `src/server/services/zrokAgentConsoleClient.ts`
- Create: `tests/server/zrokAgentConsoleClient.test.ts`

**Interfaces:**
- Produces: `createZrokAgentConsoleClient(options).getStatus(): Promise<ZrokLocalAgentStatus>`
- Produces: `selectTargetShare(status, target): { kind: 'none' | 'one' | 'ambiguous'; share?: ZrokLocalAgentShare }`
- `ZrokLocalAgentShare` contains only `shareMode`, `backendMode`, `backendEndpoint`, `frontendEndpoint`, and `status`; it excludes token fields.

- [ ] **Step 1: Write failing tests** for bounded loopback discovery, rejecting non-loopback overrides, sanitized payload parsing, exact canonical-target matching, bare/custom frontend endpoints, and ambiguous matches.

```ts
test('discovers a target share without returning its token', async () => {
  const client = createZrokAgentConsoleClient({
    ports: [8888],
    fetchImpl: fakeAgentFetch({
      shares: [{ token: 'secret', shareMode: 'public', backendMode: 'proxy', backendEndpoint: 'http://127.0.0.1:3000/', frontendEndpoint: 'account.example.net', status: 'active' }],
    }),
  });
  const status = await client.getStatus();
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(selectTargetShare(status, 'http://127.0.0.1:3000').kind, 'one');
});
```

- [ ] **Step 2: Run the new test and confirm RED.**

Run: `npx tsx --test tests/server/zrokAgentConsoleClient.test.ts`

Expected: FAIL because the client module does not exist.

- [ ] **Step 3: Implement the minimal console client** with loopback validation, sequential bounded port probing, timeout, response-size/schema checks, token omission, and unique target selection.

- [ ] **Step 4: Run the new test and confirm GREEN.**

Run: `npx tsx --test tests/server/zrokAgentConsoleClient.test.ts`

- [ ] **Step 5: Commit the isolated client and tests.**

```powershell
git add -- src/server/services/zrokAgentConsoleClient.ts tests/server/zrokAgentConsoleClient.test.ts
git commit -m "feat: inspect local zrok agent safely"
```

### Task 2: Local-Agent authority and dynamic runtime URL

**Files:**
- Modify: `src/server/services/zrokRuntimeService.ts`
- Modify: `tests/server/zrokRuntimeService.test.ts`

**Interfaces:**
- Consumes: `ZrokAgentConsoleClient.getStatus()` and `selectTargetShare()` from Task 1.
- Produces: existing `ZrokRuntimeStatus` contract with live `baseUrl`/`mcpUrl`, local ownership from the service Agent, and structured blocked takeover reasons.

- [ ] **Step 1: Add failing runtime tests** proving a LocalSystem-profile share is local despite a different interactive env ID, bare hostname normalization uses HTTPS, custom domains remain dynamic, multiple local matches degrade, and no share/account token reaches the response.

```ts
test('uses the local Agent share across profile identities', async () => {
  const { service } = makeFixture({
    environment: { enabled: true, envZId: 'interactive-env', apiEndpoint: 'https://controller.example', accountToken: 'secret' },
    shares: [makeShare('service-env', 'share-token')],
    localAgentShares: [{ shareMode: 'public', backendMode: 'proxy', backendEndpoint: 'http://127.0.0.1:3000', frontendEndpoint: 'dynamic.example.net', status: 'active' }],
    probe: { state: 'healthy', latencyMs: 20, routedToThisMachine: true },
  });
  const actual = await service.getStatus();
  assert.equal(actual.status, 'online');
  assert.equal(actual.baseUrl, 'https://dynamic.example.net');
  assert.equal(actual.share.owner, 'local');
});
```

- [ ] **Step 2: Run the focused runtime test and confirm RED.**

Run: `npx tsx --test tests/server/zrokRuntimeService.test.ts`

Expected: FAIL because ownership still depends on interactive `envZId` and a bare host normalizes to null.

- [ ] **Step 3: Integrate the console client minimally.** Prefer the unique live local Agent share for local ownership and endpoint selection; use account discovery only when no local match exists. Normalize bare hosts to HTTPS and never synthesize a provider domain.

- [ ] **Step 4: Run runtime and route tests and confirm GREEN.**

Run: `npx tsx --test tests/server/zrokRuntimeService.test.ts tests/server/zrokRoutes.test.ts`

- [ ] **Step 5: Commit runtime integration.**

```powershell
git add -- src/server/services/zrokRuntimeService.ts tests/server/zrokRuntimeService.test.ts
git commit -m "fix: use live zrok agent runtime authority"
```

### Task 3: Bootstrap and supervisor capability handling

**Files:**
- Modify: `scripts/zrok-bootstrap.ps1`
- Modify: `scripts/verify-zrok-bootstrap.ps1`
- Modify carefully, preserving existing user changes: `scripts/start-all.ts`
- Modify carefully, preserving existing user changes: `scripts/verify-start-all.ts`
- Modify if assertions require it: `scripts/smoke-multi-mcp.mjs`
- Modify if existing prose overlaps: `docs/runtime-supervisor.md`

**Interfaces:**
- Bootstrap produces local readiness plus `remoteControl: 'available' | 'unsupported'` without a constructed public host.
- `probeZrokRuntimeStatus()` returns the live `baseUrl` in addition to status/share state.

- [ ] **Step 1: Add failing PowerShell cases** where Agent enrollment returns the classified unimplemented/501 capability but service startup continues, and where bootstrap output contains no synthesized `${reservedName}.shares.zrok.io` value.

```powershell
Invoke-Case 'unsupported remoting preserves local readiness' {
    $fake = New-FakeBootstrapOps -RemotingEnrollmentUnsupported:$true -ServiceState Running
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'account-specific-name' -EnableRemoting $true
    Assert-Equal $result.ok $true 'local readiness remains available'
    Assert-Equal $result.remoteControl 'unsupported' 'capability is explicit'
}
```

- [ ] **Step 2: Run bootstrap verification and confirm RED.**

Run: `pwsh -NoProfile -File scripts/verify-zrok-bootstrap.ps1`

- [ ] **Step 3: Implement classified optional remoting.** Reorder/guard setup so explicit unimplemented enrollment does not prevent local service readiness, preserve other enrollment failures as failures, and remove constructed public-host output.

- [ ] **Step 4: Add failing supervisor assertions** that a changed dynamic `baseUrl` from local zrok status replaces the current public probe target without restart and that absent/invalid URLs do not replace it.

- [ ] **Step 5: Run supervisor verification and confirm RED.**

Run: `npm run test:start-all`

- [ ] **Step 6: Implement dynamic supervisor URL refresh** while preserving the current dirty recovery-suppression changes in `start-all.ts`, `verify-start-all.ts`, `smoke-multi-mcp.mjs`, and `runtime-supervisor.md`.

- [ ] **Step 7: Run bootstrap, supervisor, and smoke verification and confirm GREEN.**

Run: `pwsh -NoProfile -File scripts/verify-zrok-bootstrap.ps1`

Run: `npm run test:start-all`

Run: `npm run smoke-multi-mcp`

- [ ] **Step 8: Commit only the scoped bootstrap/supervisor changes**, including pre-existing overlapping edits only after confirming they are part of the same intended recovery behavior.

### Task 4: Structured UI actionability

**Files:**
- Modify: `src/components/ZrokStatusPanel.tsx`
- Modify: `tests/components/zrokStatusPanel.test.tsx`

**Interfaces:**
- Consumes backend `actionability: { canRecheck: boolean; canTakeOver: boolean; takeoverBlockedReason?: string }`.

- [ ] **Step 1: Add failing component tests** for parsing structured actionability, hiding or disabling Take over when false, showing the blocked reason, and keeping the enabled action when true.

```ts
test('does not offer takeover when backend blocks it', () => {
  const html = renderStatus(normalizeZrokStatus({
    status: 'standby',
    actionability: { canRecheck: true, canTakeOver: false, takeoverBlockedReason: 'Remote control unsupported.' },
  }));
  assert.doesNotMatch(html, />Take over</);
  assert.match(html, /Remote control unsupported/);
});
```

- [ ] **Step 2: Run the component test and confirm RED.**

Run: `npx tsx --test tests/components/zrokStatusPanel.test.tsx`

- [ ] **Step 3: Implement the typed contract and rendering behavior** without changing unrelated panel styling.

- [ ] **Step 4: Run the component test and confirm GREEN.**

Run: `npx tsx --test tests/components/zrokStatusPanel.test.tsx`

- [ ] **Step 5: Commit the UI contract fix.**

```powershell
git add -- src/components/ZrokStatusPanel.tsx tests/components/zrokStatusPanel.test.tsx
git commit -m "fix: honor zrok takeover actionability"
```

### Task 5: Integration review and verification

**Files:**
- Review every changed and untracked file; do not modify unrelated files.

**Interfaces:**
- Consumes all prior task outputs.

- [ ] **Step 1: Review the complete diff** for hard-coded endpoints, token exposure, non-loopback console access, ambiguous-share selection, and accidental inclusion of unrelated dirty changes.

- [ ] **Step 2: Run focused verification.**

```powershell
npx tsx --test tests/server/zrokAgentConsoleClient.test.ts tests/server/zrokRuntimeService.test.ts tests/server/zrokRoutes.test.ts
npx tsx --test tests/components/zrokStatusPanel.test.tsx
pwsh -NoProfile -File scripts/verify-zrok-bootstrap.ps1
npm run test:start-all
npm run smoke-multi-mcp
npm run typecheck
git diff --check
```

- [ ] **Step 3: Restart only if needed for live verification, then perform a read-only status probe.** Assert that `baseUrl` and `mcpUrl` come from the active local Agent share, `share.owner` is local, public health is independently probed, and no token appears.

- [ ] **Step 4: Ask the reviewer agent to inspect the actual final diff and execution paths.** Send only blocking findings through one repair loop.

- [ ] **Step 5: Report exact verification and residual limitation.** Authenticated cross-machine fencing remains disabled wherever the provider reports Agent remoting unsupported.
