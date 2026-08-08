# Cross-platform architecture rule

DevFlow core/runtime is cross-platform by default.

## Required targets

- Windows and macOS are first-class targets for new core/runtime behavior.
- Linux remains supported where no unavoidable platform-specific dependency exists.

## Shared-runtime rules

- Do not hardcode drive letters, `C:\\Users\\...`, `/Users/...`, developer home paths, or machine-specific repo locations.
- Build paths with `node:path`, `os.homedir()`, `os.tmpdir()`, or DevFlow path helpers.
- Persist logical project/workspace/session IDs and repo-relative paths when identity must survive machines; absolute paths are runtime resolution details.
- Prefer `spawn` / `spawnSync` / `execFile` with argument arrays and `shell: false` for shared command execution.
- Keep Git invocation as executable + argument arrays; do not build shell command strings.
- Put unavoidable OS-specific behavior behind an explicit adapter/branch with a documented fallback or unsupported result.

## Explicit exceptions

`src/runner.ts` is the deprecated Windows-specific Agent Runner and is not an architecture baseline for new functionality. New workspace/session/execution capabilities must not depend on it.

## Verification

`npm run test:absolute-paths` scans shared runtime code for hardcoded user-home paths and `shell: true`. CI runs the portable path/process checks on Windows and macOS.
