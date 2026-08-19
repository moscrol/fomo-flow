"use strict";
// B 阶段：用「模型显式声明」重建测试状态，替代 A 阶段删掉的文本推断。
//
// A 阶段删掉 verification 段的原因：值来自解析工具输出的自由文本，五次误判。
// B 阶段要把这个信息补回来，但换取数方式。
//
// 为什么不用退出码 / --junitxml（上一轮的原计划，已证伪）：
//   cascade_wire.js:86-102 列出协议 ChatMessagePrompt 全部字段，
//   唯一的带外错误信号是 TOOL_RESULT_IS_ERROR（bool），**没有退出码**。
//   实测 `ls /nonexistent` 退出码 1，而状态栏 last_tool_ok 仍是 true——
//   工具层没把非零退出码映射成 is_error。
//   而 agent_status.js 在代理层，只看消息流、从不执行进程，
//   给 pytest 加 --junitxml 再读结果文件是 harness 本体的能力，不在射程内。
//
// 改用书里 TODO 的同一模式（ai-agent-book/chapter2/system-hint/agent.py:787
// _tool_update_todo_status）：**模型显式调工具声明 → 代码原样记录 → 零推断**。
// 参考实现里唯一带「状态」的字段就是 TODO，它的值也不是 harness 猜出来的。
//
// 三态口径照抄 intelligence/eval/synthesis_health.py（346 行，已在生产）：
//   有声明          → 用声明
//   无声明          → unknown
//   unknown         → **不产生任何结论**
// 原话（synthesis_health.py:16-17）：「这类 turn 计入 unknown 而不是默认算好——
// 『没测到』和『测到是好的』混为一谈，正是这次要修的那个毛病本身。」
// 同源纪律见 harness-reference/PLAYBOOK.md:51「没执行到就是无效样本，
// 不能计入任何一侧」。
//
// 本文件的核心断言只有一条：**这个字段的值只能来自声明，永远不来自文本。**

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dao-declared-"));
const AS = require(path.join(__dirname, "..", "vendor/外接api/core/agent_status.js"));

const P = "\x1b[32mPASS\x1b[0m", F = "\x1b[31mFAIL\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { bad++; console.log(`${F}  ${desc}\n      got=${JSON.stringify(got)}`); }
  else console.log(`${P}  ${desc}`);
}

console.log("=== A. 声明被原样记录 ===");
const k1 = "dr:basic";
let s1 = AS.recordTestReport(k1, { passed: 15, failed: 0, framework: "node" });
check("A-1: 返回 state", !!s1, true);
check("A-2: passed 原样", s1.testReport.passed, 15);
check("A-3: failed 原样", s1.testReport.failed, 0);
check("A-4: framework 原样", s1.testReport.framework, "node");
check("A-5: 标注来源为声明", s1.testReport.source, "declared");
check("A-6: 带时间戳", typeof s1.testReport.at, "number");
check("A-7: status 由数字推出（failed=0 → passed）", s1.testReport.status, "passed");

const k2 = "dr:red";
const s2 = AS.recordTestReport(k2, { passed: 12, failed: 3, framework: "pytest" });
check("A-8: failed>0 → status=failed", s2.testReport.status, "failed");

console.log("\n=== B. 没有声明就是 unknown，且 unknown 不产生任何结论 ===");
const cfg = { daoRoutes: { agentStatus: { enabled: true, defaultMode: "on" } } };
function runNoDeclare(toolOutput) {
  return AS.prepareOutbound({
    key: "dr:none:" + Math.random(),
    cfg,
    messages: [
      { role: "user", content: "跑一下测试" },
      { role: "assistant", tool_calls: [{ id: "t", function: { name: "exec", arguments: JSON.stringify({ command: "node test/foo.test.js" }) } }] },
      { role: "tool", tool_call_id: "t", name: "exec", content: toolOutput },
    ],
  }).state;
}
// 这些输入在 A 阶段之前都会产生结论。现在一个都不行——它们是文本，不是声明。
const TEXTS = [
  ["真 pytest 失败摘要", "3 failed, 9 passed in 2.41s"],
  ["真 jest 通过摘要", "Tests:       12 passed, 12 total"],
  ["全绿但含 failed 标识符", "PASS  B-2: failedTests 不含裸栈帧\n✅ 全部通过"],
  ["Node 崩溃栈", "node:internal/assert/utils:146\n  throw error;\nExit code: 1"],
  ["我自己的探针打印", "含 failed 字样吗? false"],
];
for (const [desc, body] of TEXTS) {
  const st = runNoDeclare(body);
  check(`B: ${desc} → 无 testReport`, st.testReport, undefined);
  check(`B: ${desc} → 无 verificationBlocking`, st.conclusions.verificationBlocking, undefined);
  const joined = (st.strategy || []).join(" ");
  check(`B: ${desc} → strategy 无测试指令`, joined, (s) => !/failing tests|Verification has not passed/i.test(s));
}

console.log("\n=== C. 渲染：有声明才显示，且必须标注它是声明 ===");
const barNone = AS.renderStatusBar(runNoDeclare("3 failed, 9 passed"));
check("C-1: 无声明时不渲染 test_report", barNone, (b) => !/test_report/.test(b));
check("C-2: 无声明时不渲染旧字段名", barNone, (b) => !/latest_test_status|failed_tests|verification_blocking/.test(b));

AS.recordTestReport("dr:render", { passed: 15, failed: 0, framework: "node" });
const barDeclared = AS.renderStatusBar(AS._load("dr:render"));
check("C-3: 有声明时渲染 test_report", barDeclared, (b) => /test_report/.test(b));
check("C-4: 渲染出 passed 数字", barDeclared, (b) => /passed: 15/.test(b));
check("C-5: 明确标注 self-declared（不可复核性必须可见）", barDeclared, (b) => /self-declared|declared/.test(b));

console.log("\n=== D. 声明为 failed 时才给策略，且策略可复核 ===");
AS.recordTestReport("dr:strat", { passed: 12, failed: 3, framework: "pytest" });
const stStrat = AS.prepareOutbound({
  key: "dr:strat", cfg,
  messages: [{ role: "user", content: "修测试" }],
}).state;
check("D-1: 声明 failed → 有策略", (stStrat.strategy || []).join(" "), (s) => /3 failed/.test(s));
check("D-2: 策略里带 framework 便于复核", (stStrat.strategy || []).join(" "), (s) => /pytest/.test(s));
check("D-3: 声明 failed → verificationBlocking true", stStrat.conclusions.verificationBlocking, true);

AS.recordTestReport("dr:strat", { passed: 15, failed: 0, framework: "pytest" });
const stGreen = AS.prepareOutbound({
  key: "dr:strat", cfg,
  messages: [{ role: "user", content: "修测试" }],
}).state;
check("D-4: 新声明覆盖旧声明（绿覆盖红）", stGreen.testReport.status, "passed");
check("D-5: 翻绿后不再阻塞", stGreen.conclusions.verificationBlocking, false);
check("D-6: 翻绿后无 failing tests 策略", (stGreen.strategy || []).join(" "), (s) => !/failing tests/i.test(s));

console.log("\n=== E. 非法声明一律拒绝（宁可 unknown 也不存脏数据）===");
const BAD = [
  ["缺 passed", { failed: 0 }],
  ["缺 failed", { passed: 3 }],
  ["非数字", { passed: "十五", failed: 0 }],
  ["负数", { passed: -1, failed: 0 }],
  ["NaN", { passed: NaN, failed: 0 }],
  ["空对象", {}],
  ["null", null],
  ["字符串", "15 passed"],
];
for (const [desc, arg] of BAD) {
  const key = "dr:bad:" + Math.random();
  const st = AS.recordTestReport(key, arg);
  check(`E: 拒绝 ${desc}`, st, null);
  check(`E: 拒绝 ${desc} → 不落脏数据`, (AS._load(key) || {}).testReport, undefined);
}

console.log("\n=== F. 声明不因文本而改变（隔离性）===");
AS.recordTestReport("dr:iso", { passed: 15, failed: 0, framework: "node" });
const stIso = AS.prepareOutbound({
  key: "dr:iso", cfg,
  messages: [
    { role: "user", content: "继续" },
    { role: "assistant", tool_calls: [{ id: "x", function: { name: "exec", arguments: JSON.stringify({ command: "pytest" }) } }] },
    { role: "tool", tool_call_id: "x", name: "exec", content: "999 failed, 0 passed\nFAILED everything" },
  ],
}).state;
check("F-1: 满屏 failed 文本不改变声明", stIso.testReport.status, "passed");
check("F-2: 声明的数字不被文本覆盖", stIso.testReport.passed, 15);

console.log("\n=== G. 迁移：schema 升级后旧声明不残留 ===");
check("G-1: STATE_SCHEMA 不低于 3（testReport 口径从 3 起）", AS._emptyState("x")._schema >= 3, true);

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad ? 1 : 0);
