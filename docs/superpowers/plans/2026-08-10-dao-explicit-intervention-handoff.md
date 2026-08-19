# Dao Flow Explicit Intervention and Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the current-work desk safe, explicit handoff and advisory actions without adding automatic routing or task execution.

**Architecture:** A focused `WorkItemInterventionPanel` receives a safe `WorkItem` and already-normalized advisory summary. It owns only transient UI state and delegates handoff copy/save to existing `CollaborationHandoffActions`/desktop host capabilities. The panel never writes priority or invokes pause/retry/cancel.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, existing Dao control API and Electron host bridge.

---

### Task 1: Define the safe intervention view model

**Files:**
- Create: `desktop/src/components/work/workItemInterventionModel.ts`
- Create: `desktop/src/components/work/workItemInterventionModel.test.ts`

- [x] **Step 1: Write failing tests**

Test `buildInterventionSummary` with a Work Item and the existing `/origin/ea/routing-decisions?profile=balanced&limit=20` payload. Assert it returns bounded provider/model candidates, a comparison-only sentence, no target ID, prompt, Authorization, `sk-` secret, or absolute path, and an empty summary when advisory data is absent.

- [x] **Step 2: Run focused test and verify it fails**

Run: `cd desktop && npx vitest run src/components/work/workItemInterventionModel.test.ts`

Expected: FAIL because the model does not exist.

- [x] **Step 3: Implement the pure projection**

Export `InterventionSummary`, `InterventionCandidate`, `buildInterventionSummary`. Accept `unknown` advisory data and keep only `provider`, `model`, numeric score, bounded reason, and `advisoryOnly: true`. Reuse no network or storage.

- [x] **Step 4: Run focused tests**

Run the same Vitest command; expected PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/components/work/workItemInterventionModel.ts desktop/src/components/work/workItemInterventionModel.test.ts
git commit -m "feat: add safe work intervention model"
```

### Task 2: Add explicit handoff actions to the current-work selection

**Files:**
- Create: `desktop/src/components/work/WorkItemInterventionPanel.tsx`
- Create: `desktop/src/components/work/WorkItemInterventionPanel.test.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write failing UI tests**

Mock the existing advisory GET and `/origin/ea/handoff.md` GET. Assert the panel shows “仅供比较，不会自动切换”, renders copy/save handoff actions, and never calls POST/PUT/DELETE. Assert a failed handoff read keeps the selected Work Item and shows an actionable error.

- [x] **Step 2: Run the focused UI tests and verify they fail**

Run: `cd desktop && npx vitest run src/components/work/WorkItemInterventionPanel.test.tsx`

Expected: FAIL because the panel does not exist.

- [x] **Step 3: Implement read-only advisory plus existing handoff actions**

Use `useDaoApi` for `GET /origin/ea/routing-decisions?profile=balanced&limit=20` and `GET /origin/ea/handoff.md`, `desktopHost().writeClipboard`/`saveHandoff` only through `CollaborationHandoffActions`, and transient selected-item state. Render no pause/retry/cancel controls and no priority save control. Show a loading/empty/error state with Chinese copy.

- [x] **Step 4: Run focused and regression tests**

Run: `cd desktop && npx vitest run src/components/work/WorkItemInterventionPanel.test.tsx src/components/control/CurrentWorkControlView.test.tsx src/components/control/ObservabilityControlView.test.tsx`

Expected: all pass; mock methods must be GET plus existing host actions only.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/components/work/WorkItemInterventionPanel.tsx desktop/src/components/work/WorkItemInterventionPanel.test.tsx desktop/src/components/control/CurrentWorkControlView.tsx desktop/src/theme/globals.css
git commit -m "feat: add explicit Dao work handoff actions"
```

### Task 3: Full P1 verification and taskboard handoff

**Files:**
- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`

- [x] **Step 1: Document the intervention boundary**

State that advisory is comparison-only, handoff copy/save is explicit, and pause/retry/cancel/automatic priority changes are not available.

- [x] **Step 2: Run checks**

Run `cd desktop && npm run lint && npm run typecheck && npm test && npm run build && npm run build:electron`, then `node --test test/dao-desktop-smoke.test.js` and `git diff --check`.

- [ ] **Step 3: Update taskboard**

Read `DAOFLOW-3`, add a comment with commit hashes, tests, and any runtime restriction, reread it, then move to `in_review` using its current version. Do not mark done without user acceptance.
