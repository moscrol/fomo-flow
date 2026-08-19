# Dao Flow Plain-Language UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Dao Flow's existing capabilities and APIs while making the Electron UI understandable to first-time users through three grouped navigation areas, task-oriented home cards, and conclusion-first observability copy.

**Architecture:** Keep `DaoViewId` and all existing view components stable. Add a typed navigation-group definition in `views.ts`, render groups in `Sidebar`, and use a pure `observabilitySummary` mapper to turn existing usage/alerts/failure/trace snapshots into safe, plain-language summary cards. The mapper owns terminology and status rules; React views only render and navigate.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, lucide-react, existing CSS tokens in `desktop/src/theme/globals.css`.

---

### Task 1: Add grouped navigation and plain-language labels

**Files:**
- Modify: `desktop/src/lib/views.ts`
- Modify: `desktop/src/components/Sidebar.tsx`
- Modify: `desktop/src/components/CommandPalette.tsx`
- Test: `desktop/src/components/CommandPalette.test.tsx`
- Test: `desktop/src/App.test.tsx`

- [x] **Step 1: Write the failing navigation tests**

  Add assertions that the sidebar definitions expose exactly three groups (`运行中`, `配置`, `协作`), that all 14 existing view ids still occur exactly once, and that plain labels include `接入渠道`, `模型怎么走`, `问题与数据`, `协作会话`, and `任务进度`. Keep command-palette selection using the unchanged `DaoViewId` values.

- [x] **Step 2: Run the focused tests and verify they fail**

  Run `cd desktop && npx vitest run src/components/CommandPalette.test.tsx src/App.test.tsx`.
  Expected: FAIL because the current view definitions have no groups and still use the technical labels.

- [x] **Step 3: Implement the typed group definitions**

  In `views.ts`, add `DaoViewGroupId`, `DaoViewGroupDefinition`, and a `DAO_VIEW_GROUPS` constant. Keep `DAO_VIEW_DEFINITIONS` as the source of view identity but update only display labels/descriptions and add `group` to each definition. Use these labels:

  ```ts
  { id: 'overview', label: '首页', description: '现在是否正常、下一步做什么', group: 'runtime' }
  { id: 'hud', label: '实时情况', description: '最近请求、会话和实时提醒', group: 'runtime' }
  { id: 'observability', label: '问题与数据', description: '结论、原因和技术细节', group: 'runtime' }
  { id: 'providers', label: '接入渠道', description: '添加渠道、检查可用性和模型', group: 'config' }
  { id: 'routes', label: '模型怎么走', description: '决定 Devin/Codex 请求走哪家', group: 'config' }
  ```

  Apply the corresponding plain labels from the spec to the remaining definitions. Export a helper that returns definitions by group without duplicating ids.

- [x] **Step 4: Render grouped sections without changing navigation behavior**

  Update `Sidebar` to iterate `DAO_VIEW_GROUPS`, render a non-interactive section heading, and render each group's existing buttons. Keep `aria-label="Dao 功能导航"`, `aria-current`, `⌘K`, and the runtime status footer. Update `CommandPalette` to display the group label beside each result while continuing to call `onSelect(view.id)`.

- [x] **Step 5: Run focused tests and verify they pass**

  Run `cd desktop && npx vitest run src/components/CommandPalette.test.tsx src/App.test.tsx`.
  Expected: PASS with all existing view ids selectable and the three group labels visible.

- [x] **Step 6: Commit the navigation slice**

  ```bash
  git add desktop/src/lib/views.ts desktop/src/components/Sidebar.tsx desktop/src/components/CommandPalette.tsx desktop/src/components/CommandPalette.test.tsx desktop/src/App.test.tsx
  git commit -m "feat: group Dao Flow navigation for beginners"
  ```

### Task 2: Make the home screen task-oriented

**Files:**
- Modify: `desktop/src/components/OverviewView.tsx`
- Create: `desktop/src/components/OverviewView.test.tsx`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write the failing home-card test**

  Render `OverviewView` with the existing snapshot fixture and assert the page contains `现在正常吗？`, `我要接入渠道`, `我要决定模型走哪家`, and `我要看任务和会话`. Assert each action invokes the corresponding `onNavigate` callback with `providers`, `routes`, `collaboration`, or `tasks`; assert technical endpoint text is not the first visible heading.

- [x] **Step 2: Run the focused test and verify it fails**

  Run `cd desktop && npx vitest run src/components/OverviewView.test.tsx`.
  Expected: FAIL because `OverviewView` currently has only status metrics and no navigation callback.

- [x] **Step 3: Add explicit navigation callbacks and summary copy**

  Extend `OverviewView` props with `onNavigate(view: DaoViewId): void`. Keep current status cards as a secondary “详细状态” section, and add four task cards above them. Use a status sentence derived from `status.healthy`, provider health count, and alert count: `整体正常`, `有需要注意的地方`, or `需要处理`.

- [x] **Step 4: Wire callbacks from `App` and add beginner-friendly layout styles**

  Pass `selectView` from `App`. Add only scoped classes for the task-card grid, action button, status sentence, and responsive stacking in `globals.css`; reuse existing color tokens and preserve paper/ink/night themes.

- [x] **Step 5: Run the focused test and verify it passes**

  Run `cd desktop && npx vitest run src/components/OverviewView.test.tsx src/App.test.tsx`.
  Expected: PASS.

- [x] **Step 6: Commit the home slice**

  ```bash
  git add desktop/src/components/OverviewView.tsx desktop/src/components/OverviewView.test.tsx desktop/src/App.tsx desktop/src/theme/globals.css
  git commit -m "feat: add task-oriented Dao Flow home"
  ```

### Task 3: Add a pure conclusion-first observability summary mapper

**Files:**
- Create: `desktop/src/lib/observabilitySummary.ts`
- Create: `desktop/src/lib/observabilitySummary.test.ts`

- [x] **Step 1: Write the failing mapper tests**

  Define a fixture with totals, one failed request, one warning alert, provider usage, and one routing decision. Assert `summarizeObservability` returns four safe cards with these user-facing questions: `现在正常吗？`, `刚刚发生了什么？`, `哪个渠道在工作？`, and `要不要处理？`. Assert technical labels are translated (`首字响应速度`, `复用成功`, `失败原因`, `建议顺序`) and that an empty snapshot returns a deterministic empty state with a next step.

- [x] **Step 2: Run the mapper test and verify it fails**

  Run `cd desktop && npx vitest run src/lib/observabilitySummary.test.ts`.
  Expected: FAIL because the mapper does not exist.

- [x] **Step 3: Implement pure bounded summary logic**

  Export `summarizeObservability(input)` and `ObservabilitySummary`. Normalize all values through existing `asRecord`/`asArray` helpers, clamp displayed counts, and never include prompt, token, path, header, or raw error content. Compute:

  - overall status from failure count, warning/error alerts, and healthy request ratio;
  - a natural-language request summary with success/failure counts;
  - the most-used provider plus its availability state;
  - one highest-priority attention item with a `view` target and plain-language reason.

  Add a `technicalLabel` map for TTFT/P95/cache/failure/advisory/actual-priority/budget fields. Unknown values render as `—`.

- [x] **Step 4: Run the mapper test and verify it passes**

  Run `cd desktop && npx vitest run src/lib/observabilitySummary.test.ts`.
  Expected: PASS.

- [x] **Step 5: Commit the pure model slice**

  ```bash
  git add desktop/src/lib/observabilitySummary.ts desktop/src/lib/observabilitySummary.test.ts
  git commit -m "feat: summarize observability in plain language"
  ```

### Task 4: Render conclusion-first observability and translated details

**Files:**
- Modify: `desktop/src/components/control/ObservabilityControlView.tsx`
- Modify: `desktop/src/components/control/ObservabilityControlView.test.tsx`
- Modify: `desktop/src/components/control/ControlPrimitives.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Extend the component test for summary-first rendering**

  Assert the first visible panel headings are `现在正常吗？`, `刚刚发生了什么？`, `哪个渠道在工作？`, and `要不要处理？`; assert the raw strings `TTFT`, `failureClass`, and `advisoryScore` do not appear outside a collapsible technical-details region. Assert profile switching still calls only the routing-decisions endpoint.

- [x] **Step 2: Run the focused component test and verify it fails**

  Run `cd desktop && npx vitest run src/components/control/ObservabilityControlView.test.tsx`.
  Expected: FAIL because current metric and panel headings use technical terms directly.

- [x] **Step 3: Integrate the pure summary mapper**

  Call `summarizeObservability` after each refresh and render four summary cards before routing snapshots. Give each card a one-sentence explanation and an action (`查看原因`, `去接入渠道`, `打开模型怎么走`, or `查看协作`). Keep route snapshots, alerts, failures, traces, audit, backups, import/export, and rollback behaviors intact below the summary.

- [x] **Step 4: Translate labels and progressively disclose technical fields**

  Replace naked technical labels in visible headings and badges with the spec's plain labels. Put raw factor names and exact scores inside `<details>` titled `查看技术细节`; keep actual priority explicitly distinct from advisory suggestion. Update `ControlPrimitives` only if a reusable collapsible panel is needed.

- [x] **Step 5: Run focused tests and verify they pass**

  Run `cd desktop && npx vitest run src/components/control/ObservabilityControlView.test.tsx src/lib/observabilitySummary.test.ts`.
  Expected: PASS.

- [x] **Step 6: Commit the observability slice**

  ```bash
  git add desktop/src/components/control/ObservabilityControlView.tsx desktop/src/components/control/ObservabilityControlView.test.tsx desktop/src/components/control/ControlPrimitives.tsx desktop/src/theme/globals.css
  git commit -m "feat: make observability readable for beginners"
  ```

### Task 5: Full verification and documentation

**Files:**
- Modify: `docs/DAO_DESKTOP_PARITY.md`
- Modify: `desktop/README.md`

- [x] **Step 1: Run the complete desktop checks**

  Run `cd desktop && npm run typecheck && npm run lint && npm test && npm run build && npm run build:electron`.
  Expected: all commands pass with 0 lint warnings/errors and the existing 54-test baseline plus new tests.

- [x] **Step 2: Run root checks**

  Run `npm test`, `node test/feature-coverage.test.js`, `node --test test/routing-advisory.test.js`, `node --test test/dao-desktop-smoke.test.js`, and `node test/cache-resilience.test.js`.
  Expected: 351/351 root tests, 53/53 feature coverage, 7/7 routing advisory, 2/2 desktop smoke, and cache resilience pass.

- [x] **Step 3: Update operator documentation**

  Document the three navigation groups, the four observability questions, the translated terminology, and the fact that technical details remain expandable. Preserve the unsigned macOS release and external signing caveat.

- [x] **Step 4: Commit documentation and final verification**

  ```bash
  git add docs/DAO_DESKTOP_PARITY.md desktop/README.md
  git commit -m "docs: explain Dao Flow beginner UI"
  git diff --check HEAD~5..HEAD
  ```
