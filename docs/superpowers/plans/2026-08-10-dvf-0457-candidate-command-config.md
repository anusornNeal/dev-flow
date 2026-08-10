# DVF-0457 Candidate Command Config Plan

> **For agentic workers:** execute with TDD and guarded edits; no restart or push.

**Goal:** Preserve only `.devflow/commands.yaml` and `.devflow/commands.json` inside immutable verification snapshots and make command execution identity change when relevant ignored command configuration changes.

**Architecture:** Treat repository command config as an explicit allowlisted input to verification snapshots. Candidate creation force-stages only supported command-config files into its temporary Git index so the detached snapshot remains immutable. A raw-content fingerprint travels with candidate identity/currentness and contributes to repository-config command execution identity; package scripts remain unchanged.

### Task 1 — RED: ignored config disappears today
- [ ] Add candidate execution regressions for ignored YAML and JSON presets.
- [ ] Add candidate snapshot regression proving allowlisted config is present while another ignored `.devflow` file is absent.
- [ ] Add execution-identity regression where a config-only semantic policy change changes the key.
- [ ] Run focused tests and confirm current behavior fails.

### Task 2 — Safe allowlist + fingerprint
- [ ] Export the two supported command-config relative paths from `projectCommandConfigService`.
- [ ] Add a bounded, regular-file-only raw config snapshot/fingerprint helper.
- [ ] Preserve existing parser, executable/arg/cwd validation and no-shell behavior.

### Task 3 — Immutable candidate bridge
- [ ] Force-stage only existing allowlisted command-config files into the candidate temporary Git index.
- [ ] Store candidate command-config fingerprint in registry/public identity.
- [ ] Reject snapshot/config mismatch and include fingerprint in candidate currentness.
- [ ] Do not copy arbitrary `.devflow` state.

### Task 4 — Execution identity and verification
- [ ] Include repository-config fingerprint in execution identity/cache key while leaving package-script identity unchanged.
- [ ] Preserve/validate candidate fingerprint through bind/read/execute paths.
- [ ] Run project-command, candidate, apply-and-verify focused tests and typecheck.
- [ ] Commit, integrate latest `develop`, post-integrate verify, sync evidence, close DVF-0457, cleanup worktrees.
