# Dao Flow Single-Main Consolidation Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with explicit commits and verification gates.

**Goal:** Preserve all current Dao Flow work, exclude the unsafe Kiro prototype from `main`, integrate the stable local-channel adapter, and leave one verified local `main` branch.

**Architecture:** The current Dao Flow branch remains the temporary integration branch. Recovery tags and a named WIP stash protect the pre-consolidation state. Kiro is committed only on an archive branch/tag; the reviewed `cli` and `direct-relay` adapter is cherry-picked and reconciled with the newer gateway. Mainline changes are committed in explicit functional slices.

**Tech Stack:** Git, Node.js test scripts, Electron/Vite/TypeScript Desktop, Taskboard CLI.

---

### Task 1: Freeze Recovery References and Working State

**Files:** Git refs only; no source files.

- [ ] Create local tags for `codex/prompt-cache-optimization` and `feat/local-channel-adapter` with the date and task id.
- [ ] Create a named `git stash` including untracked files for the current primary worktree; retain the stash until final verification.
- [ ] Record branch/worktree/status snapshots in the Taskboard comment, excluding secrets and request payloads.
- [ ] Verify both recovery tags and the stash exist before modifying refs.

### Task 2: Archive Kiro Without Mainline Exposure

**Files:** Only `/Users/a77/dao-proxy-worktrees/local-channel-adapter` working tree.

- [ ] Commit the adapter worktree's Kiro changes as an archive-only commit, including the Kiro channel, fake fixture, tests, factory registration, gateway session plumbing, and package test wiring.
- [ ] Tag that commit `archive/dao-flow-kiro-20260812`.
- [ ] Run the Kiro-specific selftest from the archive branch to prove the archive is recoverable.
- [ ] Remove the clean adapter worktree and delete `feat/local-channel-adapter`; retain the archive tag and the stable commit tag.

### Task 3: Integrate the Stable Adapter

**Files:** `scripts/channels/index.js`, `scripts/channels/mirasim-cli.js`, `scripts/channels/mirasim-relay.js`, `scripts/mirasim-client.js`, `scripts/mirasim-direct-relay.js`, `scripts/mirasim-openai-gateway.js`, `test/channel-adapter.test.js`, `test/mirasim-client.test.js`, `test/mirasim-openai-gateway.test.js`.

- [ ] Cherry-pick `55188ff` onto the integration branch.
- [ ] Apply the retained current MiraSim gateway/client changes on top of the adapter contract, keeping only `cli` and `direct-relay` transports and preserving existing auth/tool validation.
- [ ] Add regression coverage for the final transport registry and gateway shutdown behavior.
- [ ] Run channel tests and root gateway tests before moving to the next slice.

### Task 4: Restore and Commit Current Product Work

**Files:** Explicit paths from the retained WIP stash, grouped by responsibility.

- [ ] Apply the named WIP stash without dropping it.
- [ ] Add repository hygiene, product identity, and documentation changes in one explicit commit.
- [ ] Add root runtime, gateway, cache, observability, ACP, task, and test changes in one or more explicit commits.
- [ ] Add Desktop main-process services, IPC, and tests in an explicit commit.
- [ ] Add Desktop work, collaboration, traffic, settings, styling, and tests in an explicit commit.
- [ ] Add approved specifications, plans, handoff documents, and source design assets in an explicit documentation commit.
- [ ] Never add `.taskboard-data`, request history, diagnostics, `dist/`, release staging output, caches, or credentials.
- [ ] Run focused tests after each functional group and keep the stash until the resulting commits are verified.

### Task 5: Rebuild and Validate the Integrated Tree

**Files:** Generated output only if reproducible and explicitly approved.

- [ ] Run `git diff --check` and a sensitive/runtime-artifact path scan.
- [ ] Run root `npm test`, channel tests, and all newly added root tests.
- [ ] Run Desktop Vitest with `--maxWorkers=1`, typecheck, lint, renderer build, and Electron build.
- [ ] Rebuild the tracked VSIX only if its contents match the final source; otherwise leave the stale binary unchanged and record it as a release follow-up.
- [ ] Verify no Kiro registration, Kiro header, auto-allow permission path, Taskboard database, request history, or diagnostic dump is reachable from the final tree.
- [ ] Run `git status`, ancestry checks, and package-content inspection.

### Task 6: Fast-Forward Main and Clean Branch Topology

**Files:** Git refs and worktrees only.

- [ ] Fast-forward local `main` to the verified integration tip.
- [ ] Switch the primary worktree to `main` without changing files.
- [ ] Remove only clean auxiliary worktrees, including the empty `feat/agent-tools-optimization` worktree.
- [ ] Delete `codex/prompt-cache-optimization` after `main` points to the same commit; retain recovery/archive tags.
- [ ] Keep `origin/main` unchanged unless a later explicit push is requested.
- [ ] Apply no destructive reset/clean and do not force-push.

### Task 7: Taskboard Handoff

- [ ] Add a DAOFLOW-9 comment listing commit ids, branch topology, validation results, archived Kiro tag, and remaining release risks.
- [ ] Read the issue again and move it to `in_review` with the latest version.
- [ ] Do not mark it `done` without explicit user acceptance.
