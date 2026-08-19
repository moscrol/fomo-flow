"use strict";
// 9.9.424 升级后的持久状态迁移。
//
// 事故：新插件文件已经完整安装，8955 也是新进程，但 session JSON 仍保存着旧版
// 状态栏生成的污染字段。_load() 只补缺字段，observeMessages() 又只在 !state.goal
// 时重算 goal，于是：
//   - goal 继续是 SessionStart 的「工作区事实」注入块
//   - testRuns / failedTests 继续保留 TDD 红阶段的 A-2
//   - todo 继续停在早已完成的 t3
// 新代码在跑，旧结论却永远不被替换。
//
// 修法：引入一次性 schema 迁移。只保留不能从消息轨迹重新推导的 mode / identity /
// route / environment；清空 goal、execution、verification、todos、conclusions、strategy、
// watermark 与 seen IDs，下一个 observeMessages() 从当前完整消息重算。
//
// 第二个边界：SessionStart 的「## 工作区事实（SessionStart 自动探测）」不是 XML，
// 所以 _stripInjectedBlocks 不会移除它。它物理上排在 user 消息前面，不能成为 goal。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-status-migration-"));
process.env.HOME = tempHome;
const AS = require(path.join(__dirname, "..", "vendor/外接api/core/agent_status.js"));

const P = "\x1b[32mPASS\x1b[0m", F = "\x1b[31mFAIL\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { bad++; console.log(`${F}  ${desc}\n      got=${JSON.stringify(got)}`); }
  else console.log(`${P}  ${desc}`);
}

const key = "dao:migrate-state";
const old = AS._emptyState(key);
old._schema = 0;
old.mode = "on";
old.identity = { kind: "native", id: "real-cascade" };
old.route = { modelUid: "swe-1-6-slow", provider: "ay", upstreamModel: "gpt-5.6-terra" };
old.environment = { cwd: "/Users/a77/finance-workspace-private", os: "darwin", gitBranch: "fix/test" };
old.goal = "## 工作区事实（SessionStart 自动探测，非文档摘抄） 树: wrong";
old.phase = "debugging";
old.todos = [{ id: "t3", content: "旧待办", status: "in_progress" }];
old.execution = {
  totalToolCalls: 267,
  byTool: { exec: 164 },
  consecutiveFailures: { exec: 4 },
  sameCall: { fingerprint: "x", tool: "exec", count: 4, lastArgsPreview: "old" },
  lastTool: "exec",
  lastToolOk: false,
  lastError: { type: "CommandFailed", detail: "old A-2" },
};
// 旧状态里的 verification 段（A 阶段已从实现中删除）。这里刻意保留，
// 用来验证迁移会把它整段丢弃，而不是 fillMissing 出一个空壳。
old.verification = {
  latestTestStatus: "failed",
  failedTests: ["FAIL A-2"],
  testRuns: 27,
  consecutiveTestFailures: 4,
  testCommands: [{ tool: "exec", args: "old" }],
};
old._msgWatermark = 600;
old._seenToolResultIds = { old: 1 };
AS._save(old);

const messages = [
  {
    role: "user",
    content: [
      "## 工作区事实（SessionStart 自动探测，非文档摘抄）",
      "树: finance-workspace-private @ old",
      "解释器: /x/python",
      "", 
      "帮我验收 Devin Local 映射是否恢复",
    ].join("\n"),
  },
  {
    role: "assistant",
    tool_calls: [{ id: "test", function: { name: "exec", arguments: JSON.stringify({ command: "node test/ok.test.js" }) } }],
  },
  { role: "tool", tool_call_id: "test", name: "exec", content: "12 passed\n\nExit code: 0" },
];

const result = AS.prepareOutbound({ key, messages, cfg: { daoRoutes: { agentStatus: { enabled: true, defaultMode: "on" } } } });
const st = result.state;

console.log("=== A. 旧持久化状态只迁移一次，重算而非叠加 ===");
check("A-1: 保存用户 mode", st.mode, "on");
check("A-2: 保存 native identity", st.identity, { kind: "native", id: "real-cascade" });
check("A-3: 保存 route", st.route.provider, "ay");
check("A-4: 旧 goal 被替换", st.goal, "帮我验收 Devin Local 映射是否恢复");
// A-5~A-7 原本验证 verification 段被重算（testRuns 归 1、failedTests 清空、
// 绿输出写 passed）。A 阶段整段删除后，正确契约变成「整段丢弃」——
// 不是清空成 {} 空壳，而是字段本身不存在，下游引用会拿到 undefined。
check("A-5: 旧 verification 段被整段丢弃", st.verification, undefined);
check("A-8: 旧 lastError 清空", st.execution.lastError, null);
check("A-9: 旧 todo 不残留", st.todos, []);
check("A-10: watermark 对齐当前消息数", st._msgWatermark, messages.length);

console.log("\n=== B. 无 XML 标签的工作区事实不当 goal ===");
check("B-1: goal 不含工作区事实", st.goal, (g) => !/工作区事实|SessionStart 自动探测/.test(g || ""));

console.log("\n=== C. 迁移幂等：第二次同轨迹不重复计数 ===");
const again = AS.prepareOutbound({ key, messages, cfg: { daoRoutes: { agentStatus: { enabled: true, defaultMode: "on" } } } }).state;
// C-1 原本用 testRuns 是否重复累加来验证迁移幂等。verification 段删除后
// 换成执行层计数——它同样能证明「第二次同轨迹不重复观测」，而且不依赖
// 任何文本推断出来的字段。
check("C-1: 不重复计数（执行层）", again.execution.totalToolCalls, st.execution.totalToolCalls);
check("C-2: goal 保持真实目标", again.goal, "帮我验收 Devin Local 映射是否恢复");

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad ? 1 : 0);
