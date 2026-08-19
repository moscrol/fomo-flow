# Dao Flow 请求预演与决策中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建与真实调度共用规则的无副作用请求预演，并在 Electron 中提供人工决策收件箱与路由证据时间线。

**Architecture:** 候选生成仍由 `dao_router` 按现有配置完成，新的纯 `route_planner` 深模块统一资格、预算、建议与实际顺序。`route_decision_store` 保存有界内存证据和最小本地收件箱状态；bundled origin 仅暴露精确的本地端点，Renderer 通过安全 TypeScript 投影展示三个直白组件。

**Tech Stack:** Node.js CommonJS, existing Dao router/runtime, Electron IPC allowlist, React, TypeScript, Vitest, Node test runner.

---

## File map

- Create `vendor/外接api/core/route_planner.js`: 纯规划模块；唯一主接口 `createRoutePlan`。
- Create `vendor/外接api/core/route_decision_store.js`: 预演关联、证据 ring、收件箱去重与最小状态持久化。
- Modify `vendor/外接api/core/dao_router.js`: 调用 planner、暴露 preflight/inbox/evidence 方法、记录真实结果。
- Modify `vendor/外接api/runtime.js`: 将新能力转发给 origin。
- Modify `vendor/bundled-origin/source.js`: 严格校验并提供本地 HTTP 端点。
- Create `test/route-planner.test.js`: planner 不变量与 parity。
- Create `test/route-decision-store.test.js`: 关联、去重、持久化、上限与隐私。
- Create `test/route-decision-api.test.js`: runtime/origin 端点、零 provider 副作用、错误状态。
- Modify `desktop/electron/services/dao-control.ts`: 精确 allowlist。
- Modify `desktop/electron/services/dao-control.test.ts`: 相似路径、method、body 和 origin 拒绝测试。
- Create `desktop/src/lib/decisionCenter.ts`: raw payload 到安全 UI 模型的唯一投影。
- Create `desktop/src/lib/decisionCenter.test.ts`: 枚举、限长、脱敏、未知 payload 测试。
- Create `desktop/src/components/control/DecisionCenterControlView.tsx`: 三个用户可见区域和轮询/竞态保护。
- Create `desktop/src/components/control/DecisionCenterControlView.test.tsx`: 表单、顺序分栏、人工动作、导航、错误态。
- Modify `desktop/src/lib/views.ts`, `desktop/src/lib/views.test.ts`: 注册 `decisions` 工作台视图。
- Modify `desktop/src/components/Sidebar.tsx`: 为 `decisions` 提供显式 icon。
- Modify `desktop/src/App.tsx`, `desktop/src/App.test.tsx`: lazy render 和导航集成。
- Modify `desktop/src/theme/globals.css`: 仅 `decision-center-*` scoped 样式。
- Modify `desktop/README.md`, `docs/DAO_DESKTOP_PARITY.md`: 说明边界与使用方式。

### Task 1: RoutePlanner 深模块

**Files:**
- Create: `vendor/外接api/core/route_planner.js`
- Create: `test/route-planner.test.js`

- [x] **Step 1: 写 priority、资格与 advisory 分离的失败测试**

```js
test("priority planning preserves configured order and keeps advisory separate", () => {
  const plan = createRoutePlan({
    mode: "preflight",
    model: "coder",
    strategy: "priority",
    profile: "cheap",
    candidates: [candidate("first", "m1"), candidate("second", "m2")],
    providers: pricedProviders(),
    circuits: new Map(),
    request: { inputTokens: 1000, maxOutputTokens: 1000 },
    now: 1_786_332_000_000,
  });
  assert.deepEqual(plan.configuredOrder.map(key), ["first/m1", "second/m2"]);
  assert.deepEqual(plan.dispatchOrder.map(key), ["first/m1", "second/m2"]);
  assert.equal(plan.advisoryOrder[0].advisoryRank, 1);
  assert.equal(plan.mode, "preflight");
});
```

同时写以下测试：disabled/missing/circuit 进入 `excluded` 且不改变剩余相对顺序；输入 candidates 不被 mutation；输出 JSON 不包含候选附带的 prompt、Authorization、path、sessionId。

- [x] **Step 2: 运行测试确认失败**

Run: `node --test test/route-planner.test.js`

Expected: FAIL with `Cannot find module '../vendor/外接api/core/route_planner'`.

- [x] **Step 3: 实现最小稳定接口**

```js
function createRoutePlan(input = {}) {
  const configured = safeCandidates(input.candidates);
  const { eligible, excluded } = qualify(configured, input.providers, input.circuits, input.now);
  const budget = evaluateBudget(eligible, input.request, input.budget);
  const dispatch = applyExplicitBudgetOverride(eligible, budget);
  return Object.freeze({
    planId: safePlanId(input.planId),
    createdAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + PLAN_TTL_MS).toISOString(),
    mode: input.mode === "dispatch" ? "dispatch" : "preflight",
    model: safeText(input.model),
    profile: profiles.normalizeProfile(input.profile),
    strategy: input.strategy === "random" ? "random" : "priority",
    configuredOrder: configured,
    dispatchOrder: dispatch,
    excluded,
    advisoryOrder: rankAdvisory(configured, input),
    budget: budgetSnapshot(budget),
    warnings: warningsFor({ configured, eligible, budget }),
  });
}
```

实现固定排除枚举 `missing_provider | disabled | circuit_open | incompatible`，所有文本经过限长安全投影；不读文件、不写全局、不调用网络。

- [x] **Step 4: 写预算与 random 回归测试**

覆盖：无预算、价格未知、within cap、strict rejected、显式 cheapest；cheapest 只在所有已知 eligible 候选超预算时调整 dispatch。覆盖 random 输入顺序原样保留，planner 不再次 shuffle。

- [x] **Step 5: 运行 focused 测试并提交**

Run: `node --test test/route-planner.test.js test/routing-advisory.test.js`

Expected: PASS.

```bash
git add vendor/外接api/core/route_planner.js test/route-planner.test.js
git commit -m "feat: add pure Dao route planner"
```

### Task 2: 真实调度与 planner parity

**Files:**
- Modify: `vendor/外接api/core/dao_router.js`
- Modify: `test/routing-advisory.test.js`
- Modify: `test/codex-hot-endpoint.test.js`

- [x] **Step 1: 写真实候选顺序 parity 失败测试**

为 `_test.planRoute` 建立测试 seam，并断言：

```js
const candidates = router._test.buildDispatchCandidates(route, callOpts);
const plan = router._test.planRoute({ candidates, route, request: {} });
assert.deepEqual(
  plan.dispatchOrder.map(({ provider, model }) => `${provider}/${model}`),
  candidates.map(({ target }) => `${target.provider}/${target.model}`),
);
```

另写真实 route 桩测试，断言 priority 首次 `_tryRoute` 仍为配置首选；sticky/advisory 不能置顶；显式 cheapest 命中时才使用 planner 覆盖；strict budget 仍返回结构化 HTTP 402。

- [x] **Step 2: 运行测试确认失败**

Run: `node --test test/routing-advisory.test.js test/codex-hot-endpoint.test.js`

Expected: FAIL because `_test.planRoute` does not exist.

- [x] **Step 3: 将分散规划逻辑替换为 planner 调用**

在 `_buildDispatchCandidates` 之后只创建一次 dispatch plan：

```js
const routePlan = _createDispatchPlan({ req, target, callOpts, modelUid, candidates });
const routingDecision = _recordRoutingDecisionFromPlan(routePlan);
if (routePlan.budget.status === "strict_rejected") return budgetExceeded402(...);
for (const candidateFact of routePlan.dispatchOrder) {
  const candidate = candidates[candidateFact.actualPriority - 1];
  const selectedTarget = candidate.target;
  const ok = await _tryRoute({
    target: selectedTarget,
    callOpts,
    res,
    isJSON,
    modelUid,
    isPrimary: attempted === 0,
    w,
    effectiveModel: _isWildcard ? modelUid : undefined,
  });
  attempted += 1;
  _recordRouteAttemptEvidence(routePlan.planId, candidateFact, ok);
  if (ok) return _finishPlannedRoute(routePlan, selectedTarget, callOpts, modelUid);
}
```

在进入循环前将 `routePlan.excluded` 写入现有 trace/channelFailures；不得重复检查后又产生不同结果。保留 random 候选生成、显式 cheapest 语义和错误分类。

- [x] **Step 4: 将 routing decision 安全快照由 RoutePlan 派生**

删除只为 advisory 重复计算的 `_buildRoutingDecision` 分支，保留现有 `getRoutingDecisions(profile, limit)` 兼容形状。snapshot 必须继续包含 `mode: "advisory"`、selected、outcome、budget_override、overBudgetFallback。

- [x] **Step 5: 运行回归并提交**

Run: `node --test test/route-planner.test.js test/routing-advisory.test.js test/codex-hot-endpoint.test.js`

Expected: PASS and no configured-priority regression.

```bash
git add vendor/外接api/core/dao_router.js test/routing-advisory.test.js test/codex-hot-endpoint.test.js
git commit -m "refactor: share route planning with dispatch"
```

### Task 3: 证据与决策收件箱存储

**Files:**
- Create: `vendor/外接api/core/route_decision_store.js`
- Create: `test/route-decision-store.test.js`

- [x] **Step 1: 写 store 行为失败测试**

```js
const store = createRouteDecisionStore({ statePath, now: clock.now });
const reserved = store.reservePreflight(plan, fingerprintInput);
assert.equal(store.consumeMatchingPreflight(fingerprintInput).planId, reserved.planId);
assert.equal(store.consumeMatchingPreflight(fingerprintInput), null);

store.beginEvidence(plan);
store.appendEvidence(plan.planId, { kind: "attempt", provider: "p", model: "m" });
store.finishEvidence(plan.planId, { status: "exhausted", failureClass: "upstream" });
assert.equal(store.listEvidence(10)[0].events.at(-1).kind, "outcome");
```

再覆盖：5 分钟预演过期、200 evidence ring、24 小时 prune、inbox fingerprint 去重计数、ack、snooze、30 天过期、原子文件 reload；包含 prompt/Authorization/绝对路径/session/job/request sentinel 的输入不得出现在 JSON 或状态文件。

- [x] **Step 2: 运行测试确认失败**

Run: `node --test test/route-decision-store.test.js`

Expected: FAIL with missing module.

- [x] **Step 3: 实现内存证据与最小持久化**

```js
function createRouteDecisionStore({ statePath, now = Date.now, randomBytes = crypto.randomBytes }) {
  const reservations = new Map();
  const evidence = [];
  const inbox = loadInboxState(statePath);
  const prune = () => pruneState({ reservations, evidence, inbox, now: now() });
  return {
    reservePreflight(plan, metadata) {
      prune();
      const record = safeReservation(plan, metadata, now());
      reservations.set(record.planId, record);
      mergePlanInboxRules(inbox, plan, now());
      persistInboxState(statePath, inbox);
      return clone(record);
    },
    consumeMatchingPreflight(metadata) {
      prune();
      const fingerprint = metadataFingerprint(metadata);
      const match = Array.from(reservations.values()).reverse()
        .find((item) => item.fingerprint === fingerprint && item.consumed !== true);
      if (!match) return null;
      match.consumed = true;
      return clone(match);
    },
    beginEvidence(plan, link) {
      prune();
      const item = safeEvidence(plan, link, now(), randomBytes);
      evidence.push(item);
      prune();
      return clone(item);
    },
    appendEvidence(evidenceId, event) {
      return appendSafeEvent(evidence, evidenceId, event, now());
    },
    finishEvidence(evidenceId, outcome) {
      const item = finishSafeEvidence(evidence, evidenceId, outcome, now());
      if (item) mergeInboxRules(inbox, item, now());
      persistInboxState(statePath, inbox);
      return item && clone(item);
    },
    listEvidence(limit) {
      prune();
      return boundedNewest(evidence, limit).map(clone);
    },
    listInbox(limit) {
      prune();
      return visibleInbox(inbox, now(), limit).map(clone);
    },
    acknowledge(id) {
      const item = updateInboxState(inbox, id, { status: "acknowledged" }, now());
      persistInboxState(statePath, inbox);
      return item && clone(item);
    },
    snooze(id, untilMs) {
      const item = updateInboxState(inbox, id, { status: "snoozed", snoozedUntil: untilMs }, now());
      persistInboxState(statePath, inbox);
      return item && clone(item);
    },
  };
}
```

关联 fingerprint 只使用 model、profile、预算、stream/tools/thinking/reasoning 枚举。持久化只写 inbox fingerprint/classification/state/count/timestamps；使用同目录临时文件、`fs.writeFileSync(..., { mode: 0o600 })`、`fs.renameSync` 原子替换。

`dao_router.init` 使用 `path.join(path.dirname(configPath), "route-decision-inbox.json")` 创建 store；该文件不包含 RoutePlan、候选详情或请求元数据。

- [x] **Step 4: 实现固定规则生成 inbox**

只从安全 plan/outcome 生成：`budget_rejected`、`all_unavailable`、`exhausted`、`repeated_fallback`、`advisory_divergence`、`budget_unverified`、`plan_drift`。所有 title/message 由固定模板生成，不能拼 provider 原始错误正文。

- [x] **Step 5: 运行测试并提交**

Run: `node --test test/route-decision-store.test.js`

Expected: PASS.

```bash
git add vendor/外接api/core/route_decision_store.js test/route-decision-store.test.js
git commit -m "feat: add bounded route decision evidence store"
```

### Task 4: 本地 preflight/inbox/evidence 端点

**Files:**
- Modify: `vendor/外接api/core/dao_router.js`
- Modify: `vendor/外接api/runtime.js`
- Modify: `vendor/bundled-origin/source.js`
- Create: `test/route-decision-api.test.js`
- Modify: `test/dao-desktop-smoke.test.js`

- [x] **Step 1: 写 schema、状态码和零副作用失败测试**

测试以下请求：

```js
await post("/origin/ea/route-preflight", validInput);       // 200, mode preflight
await post("/origin/ea/route-preflight", { prompt: "x" }); // 400
await post("/origin/ea/route-preflight", unknownModel);      // 404
await get("/origin/ea/decision-inbox?limit=20");             // 200
await post(`/origin/ea/decision-inbox/${id}/ack`, {});        // 200
await post(`/origin/ea/decision-inbox/${id}/snooze`, { minutes: 60 });
await get("/origin/ea/route-evidence?limit=20");              // 200
```

在 preflight 前后比较 provider stub call count、usage、channel scorer metrics、circuits、affinity count 和 audit log，全部不得增加。

- [x] **Step 2: 运行测试确认失败**

Run: `node --test test/route-decision-api.test.js`

Expected: FAIL with 404 for new endpoints.

- [x] **Step 3: 实现 dao_router/runtime 方法**

导出：

```js
preflightRoute(input)
getDecisionInbox(limit)
acknowledgeDecision(id)
snoozeDecision(id, minutes)
getRouteEvidence(limit)
```

`preflightRoute` 只调用 `resolveRoute`、现有候选生成和 `createRoutePlan`；使用不含 prompt/workspace/session 的 synthetic call options。真实 route 在 begin/attempt/skip/outcome 时追加证据，并尝试消费一次性 metadata match。

- [x] **Step 4: 实现 origin 精确路由和 body guard**

新增 16 KiB JSON reader，拒绝未知字段、数组、嵌套任意对象和错误枚举。响应统一：

```json
{ "ok": true, "plan": {}, "message": "只是预演，不会发送请求或改变优先级。" }
```

错误统一 `{ "ok": false, "error": { "code": "INVALID_PREFLIGHT", "message": "..." } }` 并使用 400/404/503。收件箱 id 只接受 opaque ID 正则。

- [x] **Step 5: 运行 runtime/smoke 并提交**

Run: `node --test test/route-planner.test.js test/route-decision-store.test.js test/route-decision-api.test.js test/dao-desktop-smoke.test.js`

Expected: PASS.

```bash
git add vendor/外接api/core/dao_router.js vendor/外接api/runtime.js vendor/bundled-origin/source.js test/route-decision-api.test.js test/dao-desktop-smoke.test.js
git commit -m "feat: expose local Dao route decision endpoints"
```

### Task 5: Electron 精确 allowlist 与安全投影

**Files:**
- Modify: `desktop/electron/services/dao-control.ts`
- Modify: `desktop/electron/services/dao-control.test.ts`
- Create: `desktop/src/lib/decisionCenter.ts`
- Create: `desktop/src/lib/decisionCenter.test.ts`

- [x] **Step 1: 写 allowlist 失败测试**

断言精确允许：preflight POST、inbox GET、`/:opaque/ack|snooze` POST、evidence GET；拒绝 `/route-preflight/extra`、DELETE、GET body、absolute URL、`../`、任意 inbox action、超大 body。

- [x] **Step 2: 写安全投影失败测试**

```ts
expect(projectPreflight(raw).configuredOrder[0]).toMatchObject({
  provider: 'primary',
  actualPriority: 1
})
expect(JSON.stringify(projectDecisionCenter(secretPayload))).not.toMatch(
  /PROMPT_SENTINEL|Authorization|\/Users\/secret|SESSION_SENTINEL/
)
```

覆盖未知枚举 fallback、最多 20 candidates、50 inbox/evidence、每条最多 20 events、有限数值、固定中文文案。

- [x] **Step 3: 运行测试确认失败**

Run: `cd desktop && npx vitest run electron/services/dao-control.test.ts src/lib/decisionCenter.test.ts`

Expected: FAIL for new paths/module.

- [x] **Step 4: 实现 exact read/write match 与投影**

在 `dao-control.ts` 增加独立 exact matcher，不把 endpoint 加到宽泛 `WRITE_PREFIXES`。在 `decisionCenter.ts` 导出：

```ts
projectPreflight(payload: unknown): DecisionPreflight
projectInbox(payload: unknown): DecisionInboxItem[]
projectEvidence(payload: unknown): RouteEvidence[]
```

复用 `sanitizeDisplayText`；不向组件暴露 raw payload。

- [x] **Step 5: 运行测试、类型检查并提交**

Run: `cd desktop && npx vitest run electron/services/dao-control.test.ts src/lib/decisionCenter.test.ts && npm run typecheck && npm run lint -- --quiet`

Expected: PASS.

```bash
git add desktop/electron/services/dao-control.ts desktop/electron/services/dao-control.test.ts desktop/src/lib/decisionCenter.ts desktop/src/lib/decisionCenter.test.ts
git commit -m "feat: add safe decision center control boundary"
```

### Task 6: 决策中心 React 视图

**Files:**
- Create: `desktop/src/components/control/DecisionCenterControlView.tsx`
- Create: `desktop/src/components/control/DecisionCenterControlView.test.tsx`
- Modify: `desktop/src/lib/views.ts`
- Modify: `desktop/src/lib/views.test.ts`
- Modify: `desktop/src/components/Sidebar.tsx`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/App.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: 写预演表单和顺序分栏失败测试**

填写 model/profile/budget，提交后断言 POST body 只有白名单字段；页面分别出现“规定顺序”“预计实际尝试”“参考建议”，并显示“不会发送请求或改变优先级”。断言 provider/model 的 route 事实不会被当作 profile。

- [x] **Step 2: 写 inbox/evidence/竞态失败测试**

覆盖：ack/snooze 只有显式按钮才 POST；“打开路由配置”调用 `onNavigate('routes')`；“查看证据”选择对应 timeline；旧轮询响应不能覆盖新响应；卸载不 setState；错误保留上次安全数据并显示自动重试；无事项/无证据空态。

- [x] **Step 3: 写导航集成失败测试**

在 views/App/Sidebar 测试中断言 `decisions` 位于工作台、所有 view ID 唯一可达、命令面板可进入、标题为“决策中心”、旧视图成员与高级折叠行为不变。

- [x] **Step 4: 运行测试确认失败**

Run: `cd desktop && npx vitest run src/components/control/DecisionCenterControlView.test.tsx src/lib/views.test.ts src/App.test.tsx`

Expected: FAIL because view is not registered.

- [x] **Step 5: 实现三个直白区域与安全轮询**

`DecisionCenterControlView` 接收 `onNavigate`，内部只通过 `useDaoApi` 调用 Task 5 allowlist。GET inbox/evidence 并行，10 秒轮询；使用递增 sequence ref 和 effect cleanup。POST preflight 仅由表单提交触发，ack/snooze 仅由对应按钮触发。

新增 `decisions` definition：

```ts
{
  id: 'decisions',
  label: '决策中心',
  description: '发送前预演、需要你决定的事项和真实路由原因',
  eyebrow: '工作台',
  group: 'runtime'
}
```

- [x] **Step 6: 加 scoped CSS 与键盘可访问性**

只新增 `.decision-center-*` selectors；使用现有 `--border`、`--surface-low`、`--ink-muted` 等已定义 token。原生 form/button/fieldset，状态文案使用 `role="status"`，timeline 使用有序列表，重排不使用 index key。

- [x] **Step 7: 运行 focused 检查并提交**

Run: `cd desktop && npx vitest run src/components/control/DecisionCenterControlView.test.tsx src/lib/decisionCenter.test.ts src/lib/views.test.ts src/App.test.tsx src/components/Sidebar.test.tsx && npm run typecheck && npm run lint -- --quiet`

Expected: PASS.

```bash
git add desktop/src/components/control/DecisionCenterControlView.tsx desktop/src/components/control/DecisionCenterControlView.test.tsx desktop/src/lib/views.ts desktop/src/lib/views.test.ts desktop/src/components/Sidebar.tsx desktop/src/App.tsx desktop/src/App.test.tsx desktop/src/theme/globals.css
git commit -m "feat: add Dao decision center workspace"
```

### Task 7: 文档、完整验收与 Taskboard

**Files:**
- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`
- Modify: `docs/superpowers/plans/2026-08-10-dao-route-decision-center.md`

- [x] **Step 1: 更新用户文档**

写明：决策中心是本地控制面；预演不发请求；规定 priority 不被建议改变；显式 cheapest 是唯一预算顺序覆盖；ack/snooze 只管理收件箱；时间线不含 prompt/密钥/完整路径/原始 ID；没有远程执行能力。

- [x] **Step 2: 跑完整 Node 检查**

先运行以下 focused tests，再运行仓库完整测试命令：

```bash
node --test test/route-planner.test.js test/route-decision-store.test.js test/route-decision-api.test.js test/routing-advisory.test.js test/codex-hot-endpoint.test.js test/dao-desktop-smoke.test.js
npm test
```

Expected: PASS with no priority or existing gateway regression.

- [x] **Step 3: 跑完整 Desktop 检查**

```bash
cd desktop
npm test
npm run typecheck
npm run lint -- --quiet
npm run build
npm run build:electron
```

Expected: all PASS.

- [x] **Step 4: 运行 scope 与隐私检查**

```bash
git diff --check
git status --short
rg -n "PROMPT_SENTINEL|AUTH_SENTINEL|SESSION_SENTINEL|SECRET_PATH_SENTINEL" desktop/dist desktop/dist-electron 2>/dev/null
```

Expected: no sentinel output; staged files only belong to DAOFLOW-6. Do not stage unrelated pre-existing dirty files.

- [x] **Step 5: 更新计划、文档并提交**

勾选实际完成项，记录明确验证结果，不把未运行的检查写成已通过。

```bash
git add desktop/README.md docs/DAO_DESKTOP_PARITY.md docs/superpowers/plans/2026-08-10-dao-route-decision-center.md
git commit -m "docs: document Dao route decision center"
```

- [x] **Step 6: 同步 DAOFLOW-6**

使用 `taskctl issue get DAOFLOW-6` 和 `taskctl comment list DAOFLOW-6` 获取最新状态；评论实现 commit、测试、边界和剩余风险，再用最新 version 移到 `in_review`。不得直接移到 `done`。
