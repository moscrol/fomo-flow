# Dao 路由观察与处理易用化实施计划

> **For Codex:** 按测试先行逐项实施；工作区存在大量用户在途改动，只修改本计划列出的决策中心文件，不重排或覆盖无关变更。

**Goal:** 把“决策中心”改造成结论优先、真实证据优先的小白路由观察页，并将发送前预演降级为默认折叠、全选项式的可选工具。

**Architecture:** 保持现有 inbox、evidence、route-preflight API 与路由执行语义不变。`decisionCenter.ts` 负责把 routes/preflight/inbox/evidence 投影为安全、有限的展示模型；`DecisionCenterControlView` 只组合这些投影，页面加载只执行三个 GET，只有用户主动点击才 POST 预演。真实路由证据与人工事项是主流程，预演是次级工具。

**Tech Stack:** Electron、React、TypeScript、Vitest、Testing Library、electron-vite。

---

## Task 1：补齐安全展示模型

**Files:**

- Modify: `desktop/src/lib/decisionCenter.ts`
- Modify: `desktop/src/lib/decisionCenter.test.ts`

1. 先写失败测试，覆盖 `GET /origin/ea/routes` 的安全模型选项投影：只接受 route UID、provider/providerName、model/upstreamModel；稳定排序、去重、最多 100；不投影 prompt、Authorization、完整路径或原始请求 ID。
2. 写失败测试，覆盖首屏结论：无待处理事项为“目前正常”，有 urgent/warning/review 时给出准确数量和最重要事项；最近真实 outcome 显示 provider/model，没有证据时给出直白空态。
3. 写失败测试，覆盖预演结论：预算拒绝、排除项、规定首选一致和顺序偏离四种情况。
4. 实现 `projectDecisionModelOptions`、`summarizeDecisionCenter` 和 `summarizePreflight`，复用现有 sanitizer 与有限数组投影。
5. 运行 `npm test -- --run src/lib/decisionCenter.test.ts`，确认通过。

## Task 2：重排页面与交互

**Files:**

- Modify: `desktop/src/components/control/DecisionCenterControlView.tsx`
- Modify: `desktop/src/components/control/DecisionCenterControlView.test.tsx`

1. 先改 UI 测试为新验收语义：标题“路由观察与处理”、首屏结论、“最近请求走了哪里”、默认折叠“发送前检查（可选）”。
2. 在 fixture 增加只读 routes 响应，断言页面初次加载只 GET inbox/evidence/routes，未自动 POST route-preflight。
3. 断言模型、用途、预算都是 `<select>`；选定 route UID、用途和预算后，点击“查看预计路线”才发送白名单 POST，预算始终为 `strict`。
4. 增加无 routes、routes GET 失败、真实 evidence 切换、ack/snooze、旧刷新不覆盖新数据等回归。
5. 实现三段信息架构：
   - “现在要不要处理”：结论卡 + 必要的人工事项；
   - “最近请求走了哪里”：证据卡 + 所选事实时间线；
   - 默认折叠“发送前检查（可选）”：全选项式表单 + 结论优先结果。
6. routes 读取失败不得阻断日常观察；仅禁用可选检查并提供“打开路由配置”。
7. 预演结果先显示一句结论，再显示规定顺序、预计尝试、参考建议和排除原因；不得把建议写回 priority。
8. 运行两个 focused suite，并检查无自由文本输入、无自动 POST、无敏感字段进入 DOM。

## Task 3：导航文案、样式与说明

**Files:**

- Modify: `desktop/src/lib/views.ts`
- Modify: `desktop/src/lib/views.test.ts`
- Modify: `desktop/src/App.test.tsx`（仅有相关标题断言时）
- Modify: `desktop/src/theme/globals.css`
- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`

1. 侧栏名称改为“路由观察”，描述改为“最近请求实际走向、异常事项和可选发送前检查”。保留 view ID `decision` 与分组、命令面板可达性。
2. 添加仅以 `.decision-center-*` 开头的 scoped 样式：首屏结论、证据选择卡、风险事件、折叠检查区、结果结论与响应式布局。
3. 文档说明：日常只需看结论和真实证据；发送前检查仅在准备改路由/预算时使用；不会调用 provider、自动切换模型或保存 priority。
4. 更新相关模型/App 测试。

## Task 4：完整验证与实机安装

1. 运行 focused tests：decisionCenter model/view、views、App。
2. 运行 `npm run typecheck`、相关 ESLint、`git diff --check`。
3. 运行 Desktop 全量测试与 `npm run build`。
4. 打包 macOS App，备份当前 `/Applications/Dao Flow.app`，安装新包并启动。
5. 用本机 App 做视觉验收：首屏无需填写即可理解；最近路由可选；可选检查默认折叠；无 routes 时有可恢复入口；点击检查后结论清楚。
6. 复核 git 状态，只提交本切片文件；在 Taskboard 可用时写入变更、验证与剩余风险，并将 DAOFLOW-6 移到 `in_review`，不擅自标记 `done`。
