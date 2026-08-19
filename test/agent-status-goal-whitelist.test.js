"use strict";
// goal 提取：从「减法」改成「加法」。
//
// 缘起：我已经补了四轮黑名单——XML 标签块 → 纯 Markdown 段（## 工作区事实）
// → 孤立闭合标签（</available_skills>）→ 现在又来了方括号截断行
// `[additional skills truncated; use the `skill` tool to list them]`。
// 每一轮都在追下一个样本。
//
// ai-agent-book/book/chapter2.md:679-681 把这件事定性了：
//   「输入清洗：过滤外部内容中的可疑模式……这层防御容易被措辞变体绕过，
//     只能作为辅助手段。」
// 所以这不是「漏了一种模式」，是这层防御的**结构性上限**。
//
// 同书 chapter2.md:683 / 857 进一步说明后果：状态栏的信息一旦来自可被污染的
// 数据源，「这台仪器就会读出错误的刻度，反而误导模型」；:847 说模型
// 「几乎无条件地相信状态栏」，越过约 10% 容错线「比不带还糟」。
//
// 真正的分层（chapter2.md:679-681 按根本性排序）：
//   1. 结构化通道  ← 最根本，但要 Harness 侧配合，不在本模块控制范围
//   2. 白名单提取  ← 本次采用
//   3. 输入清洗    ← 现状，保留为第二道防线（:685「分层防御」）
//
// 白名单的关键不是「更准」，而是**失败方向反转**：
//   减法：遇到未知污染形状 → 泄漏进 goal → 状态栏说假话（fail open）
//   加法：遇到未知形状 → 不满足人话判据 → 被忽略 → goal 为空或取到下一句
//         （fail closed，宁可少说也不说错）
// evidence-hygiene-three-failure-shapes.md:125-140 同源：判据应落在
// 「有没有正面资格」，而不是「像不像坏东西」——后者是语义猜测，必然既漏又误伤。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dao-goal-wl-"));
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

console.log("=== A. 本轮实测的真实消息形状 ===");
// 这就是 9.9.426 运行时 goal 被污染成 "[additional skills truncated…]" 的原样输入
const REAL = [
  "## 工作区事实（SessionStart 自动探测，非文档摘抄）",
  "树: finance-workspace-private @ main (4d92497d) — 主检出树，全仓共 7 棵",
  "解释器: /Users/a77/finance-workspace-private/.venv-workbench/bin/python",
  "门禁: pre-commit 8 道（解释器用错 / 层级违规 会被拦下）",
  "",
  "继续修，你看下Agent book检索源，看看有没有最佳实现",
  "<available_skills>",
  "- **obsidian**: Work with Obsidian vaults.",
  "- **hyperframes**: READ THIS FIRST for any request.",
  "[additional skills truncated; use the `skill` tool to list them]",
  "</available_skills>",
].join("\n");
check("A-1: 取到真实诉求", goalOf(REAL), "继续修，你看下Agent book检索源，看看有没有最佳实现");

console.log("\n=== B. 未知污染形状必须 fail closed（不得泄漏进 goal）===");
// 判据不是「认识这些形状」，而是「它们都不满足人话资格」。
// 故意用一批我**没有**写进任何黑名单的形状。
const UNKNOWN_SHAPES = [
  "[additional skills truncated; use the `skill` tool to list them]",
  "[tool result truncated after 2000 chars]",
  "(3 more files not shown)",
  "<<<TRUNCATED>>>",
  "…… 省略后 30 条 ……",
  "%%% harness debug frame %%%",
  "{{ template_placeholder }}",
];
for (const shape of UNKNOWN_SHAPES) {
  check(
    `B: 不泄漏 ${JSON.stringify(shape.slice(0, 32))}`,
    goalOf(`${shape}\n真实诉求在这里`),
    "真实诉求在这里",
  );
}
check(
  "B-末: 整条消息只有未知形状 → goal 为空，不谎报",
  goalOf(UNKNOWN_SHAPES.join("\n")),
  "",
);

console.log("\n=== C. 反例：正常人话不得被误伤（防清洗过度）===");
const HUMAN = [
  "帮我把 hook 的相对路径改成绝对路径",
  "验收",
  "继续",
  "把 a < b 的判断改成 a <= b",
  "为什么 cccc 渠道会返回 502？",
  "app也有这些是吗，现在两边是同步了是吗",
  "这个 bug 在 src/foo.ts 里，麻烦看一下",
  "用 pytest 跑一下 test_foo.py 看结果",
];
for (const line of HUMAN) {
  check(`C: 原样保留 ${JSON.stringify(line.slice(0, 24))}`, goalOf(line), line);
}

console.log("\n=== D. 既有能力不得回退（回归护栏）===");
check(
  "D-1: XML 注入块",
  goalOf("<system_info>\nPlatform: macos\n</system_info>\n修状态栏"),
  "修状态栏",
);
check(
  "D-2: 孤立闭合标签",
  goalOf("- **skill**: xxx\n</available_skills>"),
  (g) => !/available_skills/.test(g || ""),
);
check(
  "D-3: 纯 Markdown 注入段",
  goalOf("## 工作区事实（SessionStart 自动探测）\n树: x @ y\n\n验收"),
  "验收",
);
check(
  "D-4: 用户自己写的标题不被当注入",
  goalOf("## 我的需求\n把 hook 改成绝对路径"),
  (g) => /hook/.test(g || ""),
);

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad ? 1 : 0);
