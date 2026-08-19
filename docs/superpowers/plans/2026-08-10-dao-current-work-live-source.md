# Dao Current Work Live Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Current Work read sessions and tasks from the same selected local runtime and explain empty live work with safe observation facts.

**Architecture:** Extend the existing exact-path observation boundary to include authenticated read-only `/origin/tasks`. Keep source selection and bearer acquisition in Electron main, then calculate only bounded counts and source labels in the renderer after normalization.

**Tech Stack:** Electron 39, TypeScript 5.9, React 18, Vitest, Testing Library, Bun, Vite

---

### Task 1: Route task facts through the selected observation source

**Files:**

- Modify: `desktop/electron/services/dao-control.ts`
- Modify: `desktop/electron/services/dao-control.test.ts`
- Modify: `desktop/electron/services/dao-observation-source.ts`
- Modify: `desktop/electron/services/dao-observation-source.test.ts`
- Modify: `desktop/electron/main.ts`

- [x] Add a failing public-boundary test that calls `source.request('/origin/tasks')`, expects source selection from HUD evidence, expects the final URL to use that source, and expects `Authorization: Bearer <main-only-key>`.
- [x] Add a failing control allowlist test that accepts exact GET `/origin/tasks` and rejects query/body variants.
- [x] Run `cd desktop && npm test -- --run electron/services/dao-observation-source.test.ts electron/services/dao-control.test.ts` and confirm the new assertions fail.
- [x] Add exact `/origin/tasks` to the observation path normalizer without prefix or query acceptance.
- [x] Inject a main-process `getLocalApiKey(base)` callback into the observation source and add its result only to the selected source task request.
- [x] Wire the callback in `main.ts` using the existing `readDaoLocalApiKey` helper.
- [x] Re-run the focused tests and confirm they pass.

### Task 2: Explain what Current Work actually observed

**Files:**

- Modify: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] Add a failing user-facing test with one stopped session, one succeeded task, and no live items; assert the page says which local source was read, reports two observed facts and two retired facts, and does not render either as current work.
- [x] Add a failing active case that reports source, observed session/task counts, and the existing live counts without exposing private IDs.
- [x] Run the focused test and confirm the new assertions fail.
- [x] Store a bounded `WorkObservationSummary` after both payloads normalize; derive only port and counts from safe normalized records.
- [x] Render a scoped observation strip and a success empty-state explanation distinct from the existing error status.
- [x] Keep the refresh sequence guard so older observation counts cannot overwrite newer data.
- [x] Re-run the focused CurrentWork and model tests.

### Task 3: Verify and ship

**Files:**

- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`

- [x] Document that HUD and task facts share the selected observation source and that empty current work can still mean successful observation.
- [x] Run Desktop focused tests, full tests, `npm run typecheck`, `npm run lint -- --quiet`, and `npm run build`.
- [x] Run root tests for HUD projection/service and endpoint selection.
- [x] Build the macOS arm64 app directory and install it without deleting the current backup.
- [x] Launch Dao Flow and verify Current Work shows a source, observed counts, and an unambiguous empty or live state.
