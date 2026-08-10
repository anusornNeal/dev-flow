## Repository

- Repo: `{{workspace.repo}}`
- Managed workspace: use the opaque workspace selected by DevFlow; do not derive or persist its filesystem path.
- Branch: `{{task.branch}}`

Use local files/git as source of truth for code state. Confirm the managed workspace/branch through DevFlow before editing; never reconstruct its physical path.
