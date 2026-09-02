# Repository Safety Rules

These rules apply to every automated or manual task in this repository.

## Worktree and cleanup safety

- Treat requests to inspect, analyse, review, or recommend cleanup as read-only. Do not delete, move, prune, or unregister anything unless the user explicitly approves execution after seeing the exact target list.
- Before removing any Git worktree, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worktree-audit.ps1` and report its result.
- Never remove the primary worktree, a dirty worktree, a worktree referenced by a running process, or a detached worktree whose commit has no durable branch or tag.
- Never create a Junction, symlink, or hard link from another worktree's `node_modules`, data, uploads, media, database, logs, or runtime directories into the primary worktree.
- Each worktree must use its own `node_modules`. Sharing the package-manager download store is allowed; sharing an installed dependency directory is not.
- Before removing a clean worktree, archive unique untracked files and create a durable branch or tag for any unreferenced detached commit.
- Remove registered worktrees only with `git worktree remove <exact-path>`. Do not recursively delete a registered worktree directory.
- After cleanup, verify the primary worktree status is unchanged, its dependency directory is populated, TypeScript compilation succeeds, and the deployed health endpoint still responds.
- If any safety check is uncertain or contradictory, stop and ask the user instead of guessing.

## Release boundaries

- Keep the new console and old collector/worker deployments separate. Do not deploy console-only changes to the old worker host.
- Preserve unrelated dirty files. Stage and release only explicitly scoped paths or use an isolated exact-commit worktree.
- A temporary release worktree must be named clearly, must not share installed dependencies with the primary worktree, and must be removed only after its commit, deployment, rollback point, and runtime verification are recorded.
