"use strict";
// 9.9.425 验收暴露的两个残留缺陷。样本就是当时状态栏自己：
//   goal: "</available_skills>"
//   failed_tests: ["throw error;"]
//   latest_test_status: failed   ← 而实测 12 个测试文件全绿
//
// 缺陷 A：孤立闭合标签
//   INJECTED_BLOCK_RE 要求开闭标签配对。<available_skills> 块很长，被 harness
//   截断或跨消息切分后，本条消息只剩尾部闭合标签，正则匹配不上，于是
//   "</available_skills>" 成了 goal。
//   此前只补了反向情况（未闭合开标签 → 吃到文本尾），漏了这一侧。
//
// 缺陷 B：过期失败结论粘滞 + 兜底抓崩溃栈
//   1. failedTests 兜底取「第一行含 error/fail 的行」，Node 崩溃栈的
//      "  throw error;" 被当成测试名——那是栈帧，不是测试身份。
//   2. _parseTestOutcome 返回 null（无法判定）时，调用方维持原状，于是
//      上一轮的 failed 永久驻留。后续真绿了也翻不回来。
//      "不知道" 与 "没变" 必须区分——这个坑在状态机/缓存失效/健康检查里同形。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dao-stale-verdict-"));
const AS = require(path.join(__dirname, "..", "vendor/外接api/core/agent_status.js"));

const P = "\x1b[32mPASS\x1b[0m", F = "\x1b[31mFAIL\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { bad++; console.log(`${F}  ${desc}\n      got=${JSON.stringify(got)}`); }
  else console.log(`${P}  ${desc}`);
}

function goalOf(content) {
  const st = AS._emptyState("g" + Math.random());
  AS.observeMessages(st, [{ role: "user", content }], {});
  return st.goal;
}

console.log("=== A. 孤立闭合标签不该成为 goal ===");
check(
  "A-1: 只剩 </available_skills>",
  goalOf("- **hyperframes**: 视频技能\n</available_skills>"),
  (g) => !/available_skills/.test(g || ""),
);
check(
  "A-2: 真实形状（诉求 + 被切断的技能块尾部）",
  goalOf("验收，并总结你做了什么优化\n- **video-use**: xxx\n</available_skills>"),
  "验收，并总结你做了什么优化",
);
check(
  "A-3: 孤立 </system_info>",
  goalOf("Platform: macos\n</system_info>\n帮我修状态栏"),
  "帮我修状态栏",
);
check(
  "A-4: 反例——正常配对块仍正确清洗",
  goalOf("<available_skills>\n- skill\n</available_skills>\n真实诉求"),
  "真实诉求",
);
check(
  "A-5: 反例——用户正常文本含 < > 不受影响",
  goalOf("把 a < b 的判断改成 a <= b"),
  "把 a < b 的判断改成 a <= b",
);

console.log("\n=== B. 测试结论字段已整段删除（A 阶段）===");
// 本节原本验证 failedTests 的噪音过滤与「绿输出必须翻回 passed」。
// A 阶段把整个 verification 段删掉了——补了三轮判据仍在误判，
// 第五次现场就是：断言「verification 段应该消失」的用例名，被这个字段
// 自己抓成「失败的测试」，再生成策略命令我先去修好它们。
// 根因在取数方式（解析自由文本），不在判据精度。
// 详见 test/agent-status-no-inferred-verdict.test.js。
function stateOf(body) {
  const st = AS._emptyState("o" + Math.random());
  AS.observeMessages(st, [
    { role: "assistant", tool_calls: [{ id: "t", function: { name: "exec", arguments: JSON.stringify({ command: "node test/agent-status.test.js" }) } }] },
    { role: "tool", tool_call_id: "t", name: "exec", content: body },
  ], {});
  return st;
}
const crash = [
  "node:internal/assert/utils:146",
  "  throw error;",
  "  ^",
  "",
  "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "0 !== 4",
  "    at Object.<anonymous> (/Users/a77/dao-proxy-pro/test/agent-status.test.js:579:10)",
  "",
  "Exit code: 1",
].join("\n");
check("B-1: 崩溃栈不再产生 verification 段", stateOf(crash).verification, undefined);
check("B-2: 绿输出不再产生 verification 段", stateOf("12 passed\n\nExit code: 0").verification, undefined);
check("B-3: 含 failed 标识符的绿输出同样不产生", stateOf("PASS  x: failedTests 不含栈帧\n✅ 全部通过").verification, undefined);
check("B-4: 执行层计数仍正常", stateOf(crash).execution.totalToolCalls, 1);

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad ? 1 : 0);
