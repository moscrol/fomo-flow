"use strict";
// 历史：本文件原本验证 latest_test_status / test_runs 的两个假绿灯缺陷
// （exec 操作测试文件被计成跑测试；裸 "pass"/"ok" 子串被判成通过）。
//
// A 阶段后这些断言全部作废——不是因为修好了，而是因为**整个 verification 段
// 被删除**。补了三轮判据（豁免 exec / 只认结构化摘要 / 过滤栈帧噪音）之后仍在
// 误判，第五次现场是：断言「verification 段应该消失」的用例名，被这个字段
// 自己抓成「失败的测试」，并生成策略命令我先去修好它们。
//
// 根因不在判据精度，在取数方式：值来自工具输出的自由文本，而 stdout 里混着
// 真实结果、源码、注释和探针打印，任何正则都无法区分。
// 对照 ai-agent-book/chapter2/system-hint 参考实现：状态栏只有 5 个字段，
// 全文无 re.match/search/sub/findall，判失败只看 except / returncode / success。
//
// 保留本文件的意义：钉住「这些输入不得再产生任何测试结论」。
// 原来的正向断言（哪种输入该判 passed）留到 B 阶段用带外结构化信号重建。
//
// 详见 test/agent-status-no-inferred-verdict.test.js 与
// vendor/外接api/core/agent_status.js 的 _emptyState 处长注释。

const path = require("path");
const AS = require(path.join(__dirname, "..", "vendor/外接api/core/agent_status.js"));

function run(toolName, args, resultBody) {
  const st = AS._emptyState("t2:" + Math.random());
  const id = "c1";
  AS.observeMessages(st, [
    { role: "user", content: "做点事" },
    {
      role: "assistant",
      tool_calls: [{ id, function: { name: toolName, arguments: JSON.stringify(args) } }],
    },
    { role: "tool", tool_call_id: id, name: toolName, content: resultBody },
  ], {});
  return st;
}

const F = "\x1b[31mFAIL\x1b[0m", P = "\x1b[32mPASS\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? P : F}  ${desc}`);
  if (!ok) console.log(`      got=${JSON.stringify(got)}\n      want=${JSON.stringify(want)}`);
}

console.log("=== A. 曾经产生假绿灯的输入，现在不产生任何测试结论 ===");
const CASES = [
  ["wc -l test/*.test.js", "wc -l test/prompt-cache-policy.test.js", "451 test/prompt-cache-policy.test.js\n\nExit code: 0"],
  ["ls test/", "ls test/", "agent-status.test.js\ncache-resilience.test.js\n\nExit code: 0"],
  ["cat 测试源码", "cat test/agent-status.test.js", "\"use strict\";\n// some test source\n\nExit code: 0"],
  ["'bypass' 含 pass 子串", "npm test", "bypass cache enabled\n\nExit code: 0"],
  ["'looks ok to me'", "npm test", "looks ok to me\n\nExit code: 0"],
  ["纯 exit 0 无摘要", "node build.js", "Build complete.\n\nExit code: 0"],
  ["真实 pytest 摘要", "pytest", "3 failed, 9 passed in 2.41s"],
  ["真实 jest 摘要", "npx jest", "Tests:       12 passed, 12 total"],
];
for (const [desc, cmd, body] of CASES) {
  const st = run("exec", { command: cmd }, body);
  check(`A: ${desc} → 无 verification 段`, st.verification, undefined);
}

console.log("\n=== B. 渲染层不再输出测试字段 ===");
const bar = AS.renderStatusBar(run("exec", { command: "pytest" }, "3 failed, 9 passed"));
for (const field of ["latest_test_status", "test_runs", "consecutive_test_failures", "failed_tests", "verification_blocking"]) {
  check(`B: 状态栏不含 ${field}`, new RegExp(field).test(bar), false);
}

console.log("\n=== C. 反例：执行层读数仍然正常记录 ===");
const st = run("exec", { command: "pytest" }, "3 failed, 9 passed");
check("C-1: totalToolCalls 计数正常", st.execution.totalToolCalls, 1);
check("C-2: lastTool 正确", st.execution.lastTool, "exec");
check("C-3: 无带外错误 → lastToolOk true", st.execution.lastToolOk, true);

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad ? 1 : 0);
