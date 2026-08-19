# ACP Workbench 会话诊断事实卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Dao Web HUD 的安全会话诊断事实逐项接入原生 ACP Workbench 会话详情。

**Architecture:** 扩展 `collaborationModel` 的 renderer-owned provider 投影，使用纯函数 `buildAcpSessionDiagnostics` 生成有序事实卡，再由无状态 `AcpSessionDiagnostics` 负责渲染。ACP 页面只负责选择当前会话对应的 provider；不新增 API、IPC 或控制动作。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Vite、Electron/Bun。

---

### Task 1: 扩展 ACP 安全 provider 投影

**Files:**
- Modify: `desktop/src/components/collaboration/collaborationModel.ts`
- Test: `desktop/src/components/collaboration/collaborationModel.test.ts`
- Test: `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`

- [ ] **Step 1: 为 provider 延迟投影写失败测试**

在 `collaborationModel.test.ts` 增加一个快照输入，包含 `providers[0].latency.overall.p50TtftMs/p95TtftMs`、`cache.hit.p95TtftMs` 和 `cache.miss.p95TtftMs`，断言标准化结果保留数值；再用缺失字段断言得到 `null`，不把缺失样本变成 0。

- [ ] **Step 2: 运行模型测试确认失败**

运行：

```bash
./node_modules/.bin/vitest run src/components/collaboration/collaborationModel.test.ts
```

预期：新增断言因 `snapshot.providers` 尚不存在而失败。

- [ ] **Step 3: 实现最小 provider 类型与标准化**

在 `collaborationModel.ts` 增加：

```ts
export type CollaborationLatency = { p50TtftMs: number | null; p95TtftMs: number | null }
export type CollaborationProvider = {
  id: string
  latency: {
    overall: CollaborationLatency
    cache: { hit: CollaborationLatency; miss: CollaborationLatency }
  }
}
```

增加 `normalizeLatency`、`normalizeProvider`，并让 `CollaborationSnapshot` 和 `normalizeCollaborationSnapshot` 返回 `providers`。`optionalNumber` 必须继续将 `null`、空字符串和非法值归一为 `null`。

- [ ] **Step 4: 运行模型测试确认通过**

运行同一条 Vitest 命令，预期全部通过；同时确认现有 `normalizeCollaborationSnapshot` 调用无需为没有 provider 的 fixture 添加伪数据。

- [ ] **Step 5: 提交模型切片**

```bash
git add desktop/src/components/collaboration/collaborationModel.ts desktop/src/components/collaboration/collaborationModel.test.ts
git commit -m "feat: project ACP provider diagnostics"
```

### Task 2: 创建纯事实卡构建器与展示组件

**Files:**
- Create: `desktop/src/components/collaboration/acpSessionDiagnostics.ts`
- Create: `desktop/src/components/collaboration/acpSessionDiagnostics.test.ts`
- Create: `desktop/src/components/collaboration/AcpSessionDiagnostics.tsx`
- Modify: `desktop/src/theme/globals.css`

- [ ] **Step 1: 写事实卡构建器失败测试**

覆盖两个输入：

1. 完整会话 + provider：断言 14 个事实的标签顺序、`720 ms` 的渠道 P95、`1.2万` 推理 Token，以及验证/失败事实的 `bad` tone。
2. 缺失 provider + 无缓存样本：断言延迟显示 `—`、缓存显示 `—`、未知状态不被推断为成功。

- [ ] **Step 2: 运行新测试确认失败**

```bash
./node_modules/.bin/vitest run src/components/collaboration/acpSessionDiagnostics.test.ts
```

预期：因构建器文件不存在而失败。

- [ ] **Step 3: 实现 `buildAcpSessionDiagnostics`**

导出：

```ts
export type AcpSessionDiagnosticFact = {
  label: string
  value: string
  note: string
  tone: 'good' | 'warn' | 'bad' | 'muted' | 'brand'
}

export function buildAcpSessionDiagnostics(
  session: CollaborationSession,
  provider: CollaborationProvider | undefined,
  now: number
): AcpSessionDiagnosticFact[]
```

按 spec 中的 14 项顺序构建；格式化只调用现有 `hudFormatters`/`formatRelativeAge`。阻塞、最近工具失败、已有错误或正处于 stale 时才提高 tone；缺失 provider/样本使用 `muted` 和 `—`。

- [ ] **Step 4: 实现无状态 `AcpSessionDiagnostics`**

组件接收 `{ session, provider, now }`，调用构建器，渲染 `section[aria-label="会话诊断"]` 和 `.collaboration-session-facts` 网格。每张卡输出 label、value、note 和一个仅供视觉使用的 tone marker，不输出内部 ID 或 raw 对象。

- [ ] **Step 5: 添加窄窗口与风险 tone 样式**

在 `globals.css` 为 `.acp-session-diagnostics`、`.acp-session-diagnostic-marker` 及 `tone-good/warn/bad/muted/brand` 添加最小样式；沿用现有事实卡网格和移动端单列规则，不改变全局布局。

- [ ] **Step 6: 运行构建器与组件测试确认通过**

```bash
./node_modules/.bin/vitest run src/components/collaboration/acpSessionDiagnostics.test.ts
```

预期：完整数据、缺失数据和 tone 断言全部通过。

- [ ] **Step 7: 提交纯展示切片**

```bash
git add desktop/src/components/collaboration/acpSessionDiagnostics.ts desktop/src/components/collaboration/acpSessionDiagnostics.test.ts desktop/src/components/collaboration/AcpSessionDiagnostics.tsx desktop/src/theme/globals.css
git commit -m "feat: add ACP session diagnostic facts"
```

### Task 3: 接入 ACP Workbench 并做集成验证

**Files:**
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`

- [ ] **Step 1: 扩展页面状态与 provider 选择**

给空快照补 `providers: []`；`SessionDetail` 接收 `providers`，按 `session.route.provider` 精确查找 provider，并把结果传给 `AcpSessionDiagnostics`。不要增加第二个 snapshot 请求。

- [ ] **Step 2: 在现有路由与待办之间挂载事实卡**

删除 ACP 页面内重复的六项 inline facts，替换为：

```tsx
<AcpSessionDiagnostics
  now={now}
  provider={selectedProvider}
  session={session}
/>
```

保留交接动作、语义活动流和安全说明的相对顺序。

- [ ] **Step 3: 扩展集成测试**

在现有 snapshot fixture 添加 provider latency、verification 和 failures，断言页面出现“验证”“失败信号”“推理 Token”“渠道 TTFT P95”“缓存未命中 P95”，并断言 `720 ms`；保留来源筛选和空态断言。

- [ ] **Step 4: 运行完整桌面验证**

```bash
cd desktop
npm test
npm run typecheck
npm run lint
npm run build
npm run build:electron
cd ..
node --test test/dao-desktop-smoke.test.js
```

预期：所有命令退出码为 0，桌面测试维持全绿，构建产物成功生成。

- [ ] **Step 5: 检查差异并提交本切片**

```bash
git diff --check
git status --short
git add desktop/src/components/collaboration/collaborationModel.ts desktop/src/components/collaboration/collaborationModel.test.ts desktop/src/components/collaboration/acpSessionDiagnostics.ts desktop/src/components/collaboration/acpSessionDiagnostics.test.ts desktop/src/components/collaboration/AcpSessionDiagnostics.tsx desktop/src/components/control/AcpWorkbenchControlView.tsx desktop/src/components/control/AcpWorkbenchControlView.test.tsx desktop/src/theme/globals.css
git diff --cached --check
git commit -m "feat: complete ACP session diagnostics slice"
```

只允许暂存上述文件；根目录现有代理、缓存、旧 Web 和发行物改动必须继续保持未暂存。
