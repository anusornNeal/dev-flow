# Cross-platform architecture rule

DevFlow core/runtime is cross-platform by default.

## Required targets

- Windows and macOS are first-class targets for core/runtime behavior.
- Linux remains supported where no unavoidable platform-specific dependency exists.

## Shared-runtime rules

- Do not hardcode drive letters, `C:\\Users\\...`, `/Users/...`, developer home paths, or machine-specific repo locations.
- Build paths with `node:path`, `os.homedir()`, `os.tmpdir()`, or DevFlow path helpers.
- Persist logical project/workspace/session IDs and repo-relative paths when identity must survive machines; absolute paths are runtime resolution details.
- Prefer `spawn` / `spawnSync` / `execFile` with argument arrays and `shell: false` for shared command execution.
- Keep Git invocation as executable + argument arrays; do not build shell command strings.
- Put unavoidable OS-specific behavior behind an explicit adapter/branch with a documented fallback or unsupported result.

## Platform adapters

### Startup and OpenAI Tunnel

- Windows and macOS use the same `tunnel-client runtimes` lifecycle through `scripts/openai-tunnel.ts`; no OS service manager or provider-specific bootstrap is required.
- `start:all` starts/reuses the local DevFlow API first, then connects the configured OpenAI tunnel alias to the local `/mcp` endpoint.
- Tunnel runtime state defaults to ignored `.devflow/tunnel-client`; the runtime API key remains an environment secret and is passed to tunnel-client by `env:<name>` reference rather than written into repository state.
- Intentional supervisor shutdown stops the DevFlow-managed tunnel. Guarded API-only restart leaves the tunnel running while the API child is replaced.

### Agent execution

- Fresh-process launcher handoff is retired on every platform; `src/runner.ts` and `scripts/trigger-agent.bat` fail closed instead of spawning an agent CLI.
- Managed DevFlow execution sessions and external worker synchronization are the supported cross-platform execution boundaries.
- Existing `agent_runs` rows and `.devflow/runs` artifacts remain cold read-only history and are not deleted by launcher retirement.

### Credential vault

- Windows persists integration credentials with current-user DPAPI.
- macOS persists them as current-user generic passwords in Keychain via `/usr/bin/security`.
- If the secure platform provider is unavailable, writes fail closed. Environment variables remain valid runtime overrides and are not copied into the persistent vault.

## Verification

`npm run test:absolute-paths` scans shared runtime code, including `src/runner.ts`, for hardcoded user-home paths and `shell: true`. Platform-focused tests construct explicit `win32` and `darwin` launch/bootstrap selections so Windows CI can still verify the macOS branch deterministically; macOS CI remains the authoritative native smoke environment.
