# dao-proxy-pro 9.9.417

## Automatic Workspace Change Review

- Module 8 automatically snapshots open workspace roots after extension activation.
- Changes made by Codex, Devin saves, and external processes are captured through file watchers and workspace events.
- Multi-root workspaces and later workspace-folder changes are supported.
- The compact review list reports added, modified, deleted, and untracked files together with line statistics.

## Review And Recovery

- Open a file in the native Devin/VS Code diff editor for a precise green/red comparison.
- Accept one file or all files to retain the disk content and advance the baseline.
- Roll back one file or all files to restore the captured preimage.
- Rollback refuses to overwrite dirty editors or files whose disk hash changed after capture.
- Added and deleted files are restored according to their original state.

## Scope And Performance

- Initial snapshots run asynchronously and are not part of model routing or task generation.
- Root-level Unity `Library`, `Temp`, and `Logs`, dependency/build directories, binary files, files over 2 MB, and snapshots beyond the configured safety limits are excluded.
- Nested project resources such as `Assets/Library` are not excluded by the Unity root-directory rule.
- Exact ACP Diff Zones cannot be retroactively created for changes already written by Codex Desktop. The module provides an equivalent review workflow and opens the native diff editor where possible.

## Verification

- Tracker tests cover modify, add, delete, accept, rollback, stale-content protection, and ignored paths.
- Webview syntax and responsive layout checks cover the module 8 review pane.
