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

### Startup and zrok

- Windows keeps the existing PowerShell + NSSM `zrokAgent` service bootstrap.
- macOS uses `scripts/zrok-bootstrap-macos.ts`. It resolves an existing `zrok2` from `DEVFLOW_ZROK_BIN`/PATH or installs the matching darwin release under `.devflow/bin/zrok2` without sudo.
- The macOS bootstrap enables `~/.zrok2`, keeps only the selected reserved name in `.devflow/zrok-selection.json`, enrolls zrok Agent remoting, starts the user-scoped Agent process when needed, and reconciles the initial public share.
- macOS Agent service state is derived from the loopback zrok Agent console instead of Windows service-manager APIs.

### Agent launch

- Windows retains `trigger-agent.bat`, `invoke-agent-trigger.ps1`, and the existing PowerShell launcher handoff.
- macOS invokes `src/runner.ts` through the repository-local `tsx` CLI. The runner writes a POSIX-compatible `launch.mjs` worker and uses `/usr/bin/script` to give CLI agents a pseudo-terminal without `shell: true`.
- Completion callbacks and run logs use the same DevFlow HTTP/run-artifact contract on both platforms.

### Credential vault

- Windows persists integration credentials with current-user DPAPI.
- macOS persists them as current-user generic passwords in Keychain via `/usr/bin/security`.
- If the secure platform provider is unavailable, writes fail closed. Environment variables remain valid runtime overrides and are not copied into the persistent vault.

## Verification

`npm run test:absolute-paths` scans shared runtime code, including `src/runner.ts`, for hardcoded user-home paths and `shell: true`. Platform-focused tests construct explicit `win32` and `darwin` launch/bootstrap selections so Windows CI can still verify the macOS branch deterministically; macOS CI remains the authoritative native smoke environment.
