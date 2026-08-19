# Buzz-inspired ACP Handoff Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, copyable and saveable Markdown handoff bundles for the selected ACP session and collaboration task.

**Architecture:** Keep handoff generation renderer-owned and pure. The model receives already-normalized safe session/task/activity data, applies a second bounded redaction pass, and emits Markdown without IDs or raw event payloads. A small React actions component calls the existing `desktopHost` clipboard/save IPC; no new runtime endpoint or write capability is introduced.

**Tech Stack:** React 18, TypeScript, Electron preload `desktopHost`, Vitest, Testing Library, existing Dao control primitives.

---

### Task 1: Add the pure handoff builder and tests

**Files:**

- Create: `desktop/src/components/collaboration/collaborationHandoff.ts`
- Create: `desktop/src/components/collaboration/collaborationHandoff.test.ts`

- [ ] **Step 1: Write failing builder tests**

Create normalized fixtures with a session goal containing `Bearer secret`, a workspace path,
route facts, todo, and repeated activities; create a task with a full command, attempts,
result summaries, and artifact path. Assert:

```ts
const sessionText = buildSessionHandoff(session, requests, 1_700_000_000_000)
expect(sessionText).toContain('# Dao ACP 会话交接')
expect(sessionText).toContain('整理产物')
expect(sessionText).not.toContain('Bearer secret')
expect(sessionText).not.toContain('/Users/private')
expect(sessionText).not.toContain(session.id)

const taskText = buildTaskHandoff(task, 1_700_000_000_000)
expect(taskText).toContain('# Dao 协作任务交接')
expect(taskText).toContain('fallback')
expect(taskText).not.toContain(task.jobId)
expect(taskText).not.toContain('/private/project/report.html')
```

Also assert both builders cap activity/attempt lines and return a non-empty safe “接手建议”。

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `./node_modules/.bin/vitest run src/components/collaboration/collaborationHandoff.test.ts`

Expected: FAIL because the builder module does not exist.

- [ ] **Step 3: Implement bounded Markdown builders**

Export `buildSessionHandoff(session, requests, generatedAt?)` and
`buildTaskHandoff(task, generatedAt?)`. Use local helpers to normalize whitespace, mask
Bearer/`sk-` credentials and Unix/Windows paths, escape Markdown line breaks, and keep all
sections deterministic. Use `buildCollaborationActivity` for the session timeline, slice to
six items, and include only `verb`, `object`, `outcome`, `detail`, and `repeatCount`. For a
task include at most five attempts and twenty already-safe artifact refs; omit job IDs and
raw command/result fields.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `./node_modules/.bin/vitest run src/components/collaboration/collaborationHandoff.test.ts`

Expected: all builder tests pass.

- [ ] **Step 5: Commit the model unit**

Run: `git add desktop/src/components/collaboration/collaborationHandoff.ts desktop/src/components/collaboration/collaborationHandoff.test.ts && git commit -m "feat: build safe ACP handoff bundles"`

### Task 2: Add copy/save actions over the existing Electron boundary

**Files:**

- Create: `desktop/src/components/collaboration/CollaborationHandoffActions.tsx`
- Create: `desktop/src/components/collaboration/CollaborationHandoffActions.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [ ] **Step 1: Write the failing actions test**

Install a fake `window.desktopHost` with `writeClipboard` and `saveHandoff` spies. Render the
component with a small Markdown string, click `复制交接包`, assert the exact string reaches
`writeClipboard`, click `另存交接包`, assert the filename reaches `saveHandoff`, and verify a
successful and a canceled save produce distinct visible notices. Assert an empty content prop
disables both actions.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `./node_modules/.bin/vitest run src/components/collaboration/CollaborationHandoffActions.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the actions component**

Use `desktopHost()` only; keep busy/notice state local. Expose `复制交接包` and `另存交接包`
buttons with `aria-label`s, call `writeClipboard(content)` and
`saveHandoff(content, filename)`, and handle `{ ok: false, canceled: true }` without claiming
success. Keep errors in a bounded Chinese notice and do not log content.

- [ ] **Step 4: Add scoped styles and run the test**

Add `.collaboration-handoff-actions`, `.collaboration-handoff-button`, and notice styles using
existing control variables. Run the focused actions test; expected PASS.

- [ ] **Step 5: Commit the actions unit**

Run: `git add desktop/src/components/collaboration/CollaborationHandoffActions.tsx desktop/src/components/collaboration/CollaborationHandoffActions.test.tsx desktop/src/theme/globals.css && git commit -m "feat: add ACP handoff copy and save actions"`

### Task 3: Wire the handoff package into both native collaboration pages

**Files:**

- Modify: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Modify: `desktop/src/components/control/TaskCenterControlView.tsx`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`
- Modify: `desktop/src/components/control/TaskCenterControlView.test.tsx`

- [ ] **Step 1: Add integration assertions**

Extend the existing ACP fixture to assert `复制交接包` appears beside the selected session;
click it and assert the clipboard receives a Markdown heading. Extend the task fixture to
assert `另存交接包` appears beside task details and receives the bounded filename
`dao-acp-task-handoff.md`.

- [ ] **Step 2: Build the selected-session handoff**

In `SessionDetail`, call `buildSessionHandoff(session, relatedRequests)` and render
`<CollaborationHandoffActions content={...} filename="dao-acp-session-handoff.md" />` below
the facts/progress and above the activity feed. Keep the action hidden in the no-session state.

- [ ] **Step 3: Build the selected-task handoff**

In `TaskDetail`, call `buildTaskHandoff(task)` and render the same actions component above the
attempt timeline. Keep the action hidden in the empty state and preserve the existing read-only
task API behavior.

- [ ] **Step 4: Run the two integration tests**

Run: `./node_modules/.bin/vitest run src/components/control/AcpWorkbenchControlView.test.tsx src/components/control/TaskCenterControlView.test.tsx`

Expected: all existing and new integration assertions pass.

- [ ] **Step 5: Commit the page integration**

Run: `git add desktop/src/components/control/AcpWorkbenchControlView.tsx desktop/src/components/control/TaskCenterControlView.tsx desktop/src/components/control/AcpWorkbenchControlView.test.tsx desktop/src/components/control/TaskCenterControlView.test.tsx && git commit -m "feat: expose ACP handoff from collaboration pages"`

### Task 4: Full verification and taskboard handoff

**Files:**

- Modify only the files listed in Tasks 1–3 if verification requires a fix.

- [ ] **Step 1: Run desktop verification**

Run: `npm --prefix desktop run typecheck && npm --prefix desktop run lint && npm --prefix desktop run test && npm --prefix desktop run build && npm --prefix desktop run build:electron`

Expected: all commands exit 0; all Vitest files pass.

- [ ] **Step 2: Run the root desktop smoke**

Run: `node --test test/dao-desktop-smoke.test.js`

Expected: both runtime lifecycle tests pass.

- [ ] **Step 3: Check diff hygiene**

Run: `git diff --check` and `git status --short --branch`. Confirm only intended files were
staged; leave unrelated user changes untouched.

- [ ] **Step 4: Update taskboard**

Use `taskctl issue get LOCAL-2` and `comment list LOCAL-2`, append the commit hashes and
verification results, read the issue again, then move it from `in_progress` to `in_review` with
the latest version. Do not mark it done until explicit user acceptance.
