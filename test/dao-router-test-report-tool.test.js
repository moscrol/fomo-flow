"use strict";
// B 阶段 router 侧接线：把 dao_report_test_result 工具注入出站请求，
// 并在代理层本地拦截执行（不透传给 LSP）。
//
// 三个落点（实测定位）：
//   dao_router.js:1055  _proxyOnlyToolNames  → 加名字，使其被代理拦截而非透传
//   dao_router.js:3689  _serverToolDefs      → 加工具定义，注入出站 tools
//   dao_router.js:7287  _executeServerTool   → 加 case，本地执行并写状态
//
// 为什么走这条路而不是改 harness：
//   协议里没有退出码（cascade_wire.js:86-102 全部字段，唯一带外错误信号是
//   TOOL_RESULT_IS_ERROR bool），代理层也不执行进程，拿不到 --junitxml。
//   但代理层**已有**本地工具机制（_localToolTranscriptByConversation:1928、
//   _localToolMessages:5868、_READ_ONLY_TOOL_NAMES 那批就是先例），
//   所以「模型声明 → 代理拦截 → 记入状态 → 合成结果回给模型」可以闭环。
//
// 模式来源：ai-agent-book/chapter2/system-hint/agent.py:787
// _tool_update_todo_status —— 参考实现里唯一带状态的字段（TODO）也是
// 模型显式调工具写入，不是 harness 猜的。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dao-router-tr-"));
const ROUTER = path.join(__dirname, "..", "vendor/外接api/core/dao_router.js");
const AS = require(path.join(__dirname, "..", "vendor/外接api/core/agent_status.js"));
const src = fs.readFileSync(ROUTER, "utf8");

const P = "\x1b[32mPASS\x1b[0m", F = "\x1b[31mFAIL\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    bad++;
    // 源码断言的 got 是整份 dao_router.js（10k+ 行），打出来会淹没输出且毫无信息。
    // 截断到 120 字符：源码类断言看「哪条没过」就够，具体位置去 grep。
    const shown = JSON.stringify(got);
    console.log(`${F}  ${desc}\n      got=${shown.length > 120 ? shown.slice(0, 120) + "…(truncated)" : shown}`);
  } else console.log(`${P}  ${desc}`);
}

const TOOL = "dao_report_test_result";

console.log("=== A. 三个落点都接上了 ===");
check("A-1: 加入 _proxyOnlyToolNames（代理拦截，不透传 LSP）", src, (s) =>
  new RegExp(`_proxyOnlyToolNames[\\s\\S]{0,400}"${TOOL}"`).test(s));
check("A-2: 有工具定义（注入出站 tools）", src, (s) =>
  new RegExp(`name:\\s*"${TOOL}"`).test(s));
check("A-3: _executeServerTool 有对应 case", src, (s) =>
  new RegExp(`case\\s+"${TOOL}"`).test(s));

console.log("\n=== B. 工具定义的 schema 必须强制两个计数都给 ===");
// 「只说通过数不说失败数」无法判断绿红，那是残缺声明。schema 层就要拦住。
const defMatch = src.match(new RegExp(`\\{[^{}]*name:\\s*"${TOOL}"[\\s\\S]*?\\n    \\},`));
check("B-1: 找到定义块", !!defMatch, true);
const def = defMatch ? defMatch[0] : "";
check("B-2: required 含 passed", def, (d) => /required:\s*\[[^\]]*"passed"/.test(d));
check("B-3: required 含 failed", def, (d) => /required:\s*\[[^\]]*"failed"/.test(d));
check("B-4: passed 是 integer 且 minimum 0", def, (d) =>
  /passed[\s\S]{0,200}type:\s*"integer"[\s\S]{0,120}minimum:\s*0/.test(d));
check("B-5: failed 是 integer 且 minimum 0", def, (d) =>
  /failed[\s\S]{0,200}type:\s*"integer"[\s\S]{0,120}minimum:\s*0/.test(d));
check("B-6: additionalProperties false（不接受额外字段）", def, (d) =>
  /additionalProperties:\s*false/.test(d));
check("B-7: 描述里说明这是自报、会进状态栏（让模型知道后果）", def, (d) =>
  /status bar|状态栏|self-report|declare/i.test(d));

console.log("\n=== C. 执行路径写入 agent_status ===");
check("C-1: case 里调用 recordTestReport", src, (s) =>
  new RegExp(`case\\s+"${TOOL}"[\\s\\S]{0,900}recordTestReport`).test(s));
// key 的选取在 _recordAgentTestReport 包装函数内部，case 里只传 callOpts。
// 所以断言要落在包装函数上，而不是在 case 的字符窗口里找 _agentStatusKey——
// 那样写只是碰巧能过或碰巧不过，与真实契约无关。
check("C-2: 包装函数用 _agentStatusKey（会话状态归属）", src, (s) =>
  /function _recordAgentTestReport[\s\S]{0,400}_agentStatusKey/.test(s));
check("C-2b: 不用 _promptCacheKey 做状态 key（那是缓存分片维度）", src, (s) =>
  !/function _recordAgentTestReport[\s\S]{0,400}_promptCacheKey/.test(s));
check("C-3: 有 _recordAgentTestReport 包装（与其他 _agentStatus 调用同构）", src, (s) =>
  /function _recordAgentTestReport/.test(s));
check("C-4: 包装里做 _agentStatus 空值防护", src, (s) =>
  /function _recordAgentTestReport[\s\S]{0,400}!_agentStatus/.test(s));

console.log("\n=== D. 返回给模型的结果必须可判读 ===");
check("D-1: 成功时返回 ok:true", src, (s) =>
  new RegExp(`case\\s+"${TOOL}"[\\s\\S]{0,900}ok:\\s*true`).test(s));
check("D-2: 拒绝时返回 ok:false（让模型知道声明没被接受）", src, (s) =>
  new RegExp(`case\\s+"${TOOL}"[\\s\\S]{0,900}ok:\\s*false`).test(s));
check("D-3: 返回是 JSON 字符串（与其他 case 一致）", src, (s) =>
  new RegExp(`case\\s+"${TOOL}"[\\s\\S]{0,900}JSON\\.stringify`).test(s));

console.log("\n=== E. 端到端：模拟 case 的执行体 ===");
// 不启动 router（要配置和网络），直接验证 agent_status 侧契约在 router 参数形状下成立
const key = "dao:router-e2e";
const okState = AS.recordTestReport(key, { passed: 16, failed: 0, framework: "node" });
check("E-1: 合法声明被接受", !!okState, true);
check("E-2: 状态可复读", AS._load(key).testReport.passed, 16);
check("E-3: 渲染标注 self-declared", AS.renderStatusBar(AS._load(key)), (b) =>
  /self-declared/.test(b));
const rejected = AS.recordTestReport(key, { passed: 5 });
check("E-4: 残缺声明被拒", rejected, null);
check("E-5: 被拒后旧声明不被破坏", AS._load(key).testReport.passed, 16);

console.log("\n=== F. 不得污染 LSP 透传路径 ===");
check("F-1: 未加入 _lspCapableToolNames（它没有 LSP 执行器）", src, (s) =>
  !new RegExp(`_lspCapableToolNames[\\s\\S]{0,400}"${TOOL}"`).test(s));
check("F-2: 重试上限时应被抑制（它是代理本地工具）", src, (s) =>
  /_retrySuppressedToolNames[\s\S]{0,200}\.\.\._proxyOnlyToolNames/.test(s));

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad ? 1 : 0);
