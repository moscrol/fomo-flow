# Dao Flow Single-Main Consolidation Design

- Date: 2026-08-12
- Taskboard: DAOFLOW-9
- Status: Approved for execution

## Goal

Make `main` the only active local development branch without losing current work, publishing
obsolete behavior, or mixing local runtime state into source history. The resulting `main` must
contain the current Dao Flow product, the stable local-channel adapter, reviewable commits, and a
verified release boundary.

## Current State

- `codex/prompt-cache-optimization` is the effective product trunk. It descends directly from
  `main` and carries the current committed Dao Flow history plus a large set of uncommitted source,
  tests, documentation, and Desktop work.
- `feat/local-channel-adapter` carries one stable adapter commit and an uncommitted Kiro ACP
  experiment.
- `feat/agent-tools-optimization` points at the effective trunk and has no unique commit or working
  tree changes.
- Local Taskboard databases, request history, build output, packaged artifacts, and preview output
  are mixed into the visible workspace state.

## Decisions

### Mainline

`codex/prompt-cache-optimization` remains the integration branch until validation is complete.
Local `main` is then fast-forwarded to the verified integration tip. No history rewrite or force
push is allowed.

### Recovery

Before integration, create local recovery references for the committed trunk and stable adapter.
Capture the Kiro experiment in a local archive commit and tag. The Kiro archive is not merged into
`main` and is not pushed as part of this task.

### Kiro

The Kiro ACP experiment is excluded because it automatically grants tool permission. Its files,
gateway changes, package scripts, and tests remain reachable only from the archive tag. Dao Flow's
explicit allow-once/deny permission boundary remains unchanged.

### Stable Local-Channel Adapter

Integrate the transport-neutral channel contract from `55188ff`, but reconcile it with the newer
MiraSim gateway already present in the effective trunk. The final tree must support only the
reviewed `cli` and `direct-relay` transports. It must not register Kiro or accept Kiro session
headers.

### Commit Boundaries

Commit existing work in dependency order:

1. repository hygiene and product identity;
2. gateway, cache, observability, ACP, task API, and their tests;
3. Desktop host services and safe IPC;
4. Desktop work, collaboration, traffic, and settings UI;
5. specifications, plans, handoff, release documentation, and approved source assets;
6. stable local-channel adapter integration;
7. regenerated release artifact only when it is reproducible from the final source tree.

Each commit uses an explicit path list. Local state and generated directories are never swept into
a commit with `git add -A`.

## Repository Boundary

The following are local-only and must be ignored or left untracked:

- `.taskboard-data/`;
- `.dao-request-history.json` and diagnostic/request dumps;
- `desktop/dist/`, `desktop/electron-dist/`, `desktop/out/`, and `desktop/release/`;
- top-level staging output under `dist/`;
- temporary release assembly output and local previews unless explicitly approved source assets;
- editor state, caches, backups, credentials, prompts, and user configuration.

Tracked packaged artifacts must either be regenerated from the final source tree and inspected or
left unchanged. A stale binary must not be committed as evidence of current source behavior.

## Validation

Before moving `main`, all of the following must pass on the single integrated tree:

1. `git diff --check` and a sensitive/runtime-artifact path scan;
2. root `npm test` plus focused tests for newly added gateway, cache, ACP, task, observability, and
   local-channel behavior;
3. Desktop full Vitest suite with a bounded worker count;
4. Desktop typecheck, lint, renderer build, and Electron build;
5. package creation and package-content inspection when the tracked VSIX changes;
6. ancestry checks proving `main` and `origin/main` are ancestors of the integration tip;
7. clean tracked state after commits, with only explicitly documented local ignored state.

## Finalization

After validation:

1. fast-forward local `main` to the integration tip;
2. point the primary worktree at `main` without changing its files;
3. remove clean auxiliary worktrees;
4. delete merged local development branches;
5. retain local recovery/archive tags;
6. update DAOFLOW-9 with commits, validation results, remaining risks, and move it to `in_review`;
7. do not mark the Taskboard issue `done` without explicit user acceptance.

## Failure Handling

- If a slice fails its focused tests, keep it on the integration branch and fix it before moving
  `main`.
- If adapter reconciliation changes behavior beyond the two reviewed transports, omit the adapter
  and retain its recovery reference.
- If a worktree gains new changes during consolidation, preserve it and do not delete its branch.
- If package generation is not reproducible, keep the source commits and report the package as a
  remaining release task instead of committing an inconsistent binary.
