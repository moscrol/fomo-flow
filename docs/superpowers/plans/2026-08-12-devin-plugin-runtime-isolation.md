# Devin Plugin Runtime Isolation Implementation Plan

> **Superseded:** 用户已明确要求 Devin 插件与 Dao Flow App 分离。本计划不再执行；当前边界见 `docs/superpowers/specs/2026-08-12-devin-native-entry-design.md`。App 只打开官方 Devin 窗口，不管理任何 Devin 插件。

> **For agentic workers:** REQUIRED SUB-SKILL: Use inline test-first execution and track every checkbox before packaging.

**Goal:** Open Dao Flow's default native Devin window without activating the installed Dao plugin, while preserving the user's normal Devin profile and the explicit hosted ACP path.

**Architecture:** Keep the existing renderer and IPC contract unchanged. Harden the main-process launcher by adding the fixed `dao-agi.dao-proxy-pro` extension ID to Devin's non-persistent per-window disable flag; renderer input remains limited to the opaque workspace handle. Record the exact source/test/document boundary in a delivery handoff instead of sweeping unrelated dirty-tree changes into the release.

**Tech Stack:** Electron main process, TypeScript, Vitest, Devin Desktop CLI, electron-builder, macOS process/log inspection.

---

### Task 1: Lock the per-window plugin isolation contract

**Files:**

- Modify: `desktop/electron/services/devin-native-launch.test.ts`
- Modify: `desktop/electron/services/devin-native-launch.ts`

- [ ] **Step 1: Write the failing launcher assertion**

Change the expected fixed CLI arguments to:

```ts
[
  '--new-window',
  '--disable-extension',
  'dao-agi.dao-proxy-pro',
  '--agents',
  '/Users/private/project'
]
```

Also assert that the renderer cannot supply an extension ID or additional CLI arguments because `launchNativeDevin` accepts only `workspacePath` and injected test dependencies.

- [ ] **Step 2: Run the focused test and verify the new assertion fails**

Run:

```bash
cd desktop && npm test -- electron/services/devin-native-launch.test.ts --maxWorkers=1
```

Expected: the first test fails because the current launcher omits `--disable-extension dao-agi.dao-proxy-pro`.

- [ ] **Step 3: Implement the fixed main-process argument list**

Add a source-owned constant and use it in the spawn arguments:

```ts
export const DAO_DEVIN_EXTENSION_ID = 'dao-agi.dao-proxy-pro'

const args = [
  '--new-window',
  '--disable-extension',
  DAO_DEVIN_EXTENSION_ID,
  '--agents',
  workspacePath
]
```

Do not add `--user-data-dir`, `--extensions-dir`, `--transient`, provider, model, protocol, or priority arguments.

- [ ] **Step 4: Run launcher and ACP host regression tests**

Run:

```bash
cd desktop && npm test -- electron/services/devin-native-launch.test.ts electron/services/devin-acp-host.test.ts --maxWorkers=1
```

Expected: both files pass, proving the default native launcher is isolated and the explicit hosted ACP path still works.

- [ ] **Step 5: Commit only the launcher slice**

```bash
git add -- desktop/electron/services/devin-native-launch.ts desktop/electron/services/devin-native-launch.test.ts
git diff --cached --check
git commit -m "fix(desktop): isolate Dao plugin from native Devin entry"
```

### Task 2: Correct user-facing behavior and acceptance records

**Files:**

- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`
- Create: `docs/DAO_FLOW_RELEASE_HANDOFF_2026-08-12.md`

- [ ] **Step 1: Correct the native entry description**

Document that the default action uses:

```text
--new-window --disable-extension dao-agi.dao-proxy-pro --agents <workspace>
```

State that the flag is non-persistent and window-scoped, keeps the user's Devin login/settings/other extensions, does not affect existing windows, and does not change provider/model/protocol/priority. Keep hosted ACP documented as a separate explicit advanced action.

- [ ] **Step 2: Update the parity matrix and remove stale test totals**

Change the `Devin 接入` row and overview paragraph so they no longer describe the default path as an Electron-hosted ACP session. Replace historical Desktop test totals with the totals observed during Task 3; do not preserve contradictory `68 / 278`, `76 / 307`, or `76 / 309` claims as the current result.

- [ ] **Step 3: Write the auditable release handoff**

Record:

```markdown
- Installed app path and version
- Default native entry behavior
- Advanced hosted ACP behavior
- Source/test/document files deliberately included
- Runtime dumps, request history, backups, build directories, generated VSIX and unrelated dirty changes deliberately excluded
- Exact verification commands and observed totals
- Residual risk: an already-open user Devin window may keep its intentionally enabled plugin active
```

The handoff must not contain prompts, Authorization values, API keys, full session/job IDs, or diagnostic dump contents.

- [ ] **Step 4: Check documentation consistency**

Run:

```bash
rg -n -- '--new-window --agents|不依赖、不修改 Devin 插件|68 个测试文件|278 个测试|307 个测试' desktop/README.md docs/DAO_DESKTOP_PARITY.md docs/DAO_FLOW_RELEASE_HANDOFF_2026-08-12.md
git diff --check -- desktop/README.md docs/DAO_DESKTOP_PARITY.md docs/DAO_FLOW_RELEASE_HANDOFF_2026-08-12.md
```

Expected: `rg` returns no contradictory current-behavior claims, and `git diff --check` succeeds.

### Task 3: Validate, package, install, and prove isolation

**Files:**

- Modify: `docs/superpowers/specs/2026-08-12-devin-native-entry-design.md`
- Modify: `docs/DAO_FLOW_RELEASE_HANDOFF_2026-08-12.md`

- [ ] **Step 1: Run full Desktop quality gates**

Run:

```bash
cd desktop && npm test -- --maxWorkers=1
cd desktop && npm run typecheck
cd desktop && npm run lint
cd desktop && npm run pack:mac
```

Expected: every command exits zero. Record the exact test file/test totals reported by Vitest.

- [ ] **Step 2: Run root gateway regressions**

Run:

```bash
npm test
```

Expected: exit zero. Record the exact Node test total without exposing request payloads or credentials.

- [ ] **Step 3: Install the new arm64 app recoverably**

Quit only Dao Flow, move the current `/Applications/Dao Flow.app` to a timestamped private backup directory, copy `desktop/release/mac-arm64/Dao Flow.app` into `/Applications`, and launch it. Do not quit Devin, uninstall extensions, or modify the user's Devin profile.

- [ ] **Step 4: Verify window-level isolation on the installed app**

Before opening the default entry, record safe checksums/mtimes for known Dao plugin runtime files and snapshot the existing Devin extension-host process IDs. Open a new default Devin window from the installed Dao Flow app, then confirm:

```text
- the new Devin Agents window opens for the selected workspace;
- its window logs do not contain an activation entry for dao-agi.dao-proxy-pro;
- no new dao-acp-stdio-proxy.js child is attributable to that window;
- existing user Devin windows and their processes remain untouched;
- the advanced hosted ACP UI remains available;
- cccc route configuration still reports openai-chat with the user-defined priority.
```

If an existing window writes a plugin runtime file concurrently, use the per-window Devin logs and child-process parentage for attribution instead of claiming a false global mtime invariant.

- [ ] **Step 5: Record final acceptance facts**

Replace the design document's pending acceptance paragraph and the handoff's command results with observed facts only. Include installed app path/version, test totals, typecheck/lint/package result, native-window isolation evidence, hosted ACP availability, and route invariants.

- [ ] **Step 6: Commit the verified documentation slice**

```bash
git add -- desktop/README.md docs/DAO_DESKTOP_PARITY.md docs/DAO_FLOW_RELEASE_HANDOFF_2026-08-12.md docs/superpowers/specs/2026-08-12-devin-native-entry-design.md
git diff --cached --check
git commit -m "docs: finalize Dao Flow desktop delivery"
```

### Task 4: Audit the final repository boundary

**Files:**

- Read-only: repository worktree and the commits created by this plan

- [ ] **Step 1: Inspect commits and explicit paths**

Run:

```bash
git show --stat --oneline HEAD~2..HEAD
git diff --check
git status --short --branch
```

Expected: the two implementation commits contain only the explicit launcher/test/document paths. Other pre-existing dirty files may remain and must be reported as excluded, not silently cleaned.

- [ ] **Step 2: Confirm prohibited artifacts are not staged or committed**

Verify that `.dao-request-history.json`, `_upstream_req_dump.json`, `dist/`, `release-assets/`, backups, credentials, prompts, and complete session/job IDs are absent from the two commits.

- [ ] **Step 3: Report the installed result and residual work**

Report the installed app location, exact checks that passed, commit IDs, and any unrelated dirty-tree remainder. Do not claim the repository is clean unless `git status --short` is actually empty.
