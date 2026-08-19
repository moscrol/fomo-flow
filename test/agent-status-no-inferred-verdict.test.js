"use strict";
// A 阶段：删掉靠解析自由文本推断出来的字段。
//
// 为什么删，而不是继续修判据：同一个形状我已经撞了五次——
//   判工具报错   搜 ENOENT/Traceback   → 我读的源码里就有这些词
//   判是否跑测试 搜路径含 test/         → `ls test/` 也算跑了测试
//   判测试通过   搜 pass               → `bypass cache` 命中
//   抓失败测试名 搜含 error 的行        → 抓到 Node 崩溃栈 `throw error;`
//   判测试失败   搜 failed             → 命中变量名 `failedTests`
// 最后一次的现场：我打印诊断探针「含 failed 字样吗? false」这句话本身，
// 连同解释 bug 的**注释**，一起被抓成了「失败的测试名」。
//
// 对照 ai-agent-book/chapter2/system-hint 的参考实现：
//   agent.py:199-205 `_get_system_state()` 只有 5 个字段——
//     Current Time / Current Directory / System / Shell Environment / Python Version
//   agent.py:983     工具结果上只挂两条元数据：[时间戳] [Tool call #N]
//   config.py        全部开关 5 个：timestamps / tool_counter / todo_list /
//                    detailed_errors / system_state
//   全文 **没有** re.match / re.search / re.sub / re.findall 任何一次调用。
//   判「这次调用失败了」只看三种结构化信号：
//     except Exception / result.returncode == 0 / result.get('success') is False
//   grep latest_test|failed_test|verification|can_claim|conclusion → 零命中。
//
// 书的立场并非「不该记测试状态」——chapter2.md:855 恰好把「代码到底有没有
// 通过测试」列为状态栏最有价值信息的第一例。但 :857 给了条件：
//   「状态栏注入的信息越是来自对外部世界的**真实观测**，价值越高；反过来，
//     如果状态摘要是拍脑袋编的、或来自**可被污染的数据源**，这台『仪器』
//     就会读出错误的刻度，反而误导模型。」
// 工具输出的 stdout 里混着真实结果、我写的源码、注释、探针打印——
// 它就是「可被污染的数据源」，任何正则都无法区分它们。
//
// 所以 A 阶段：删除文本推断字段与由它派生的布尔结论。
// B 阶段（后续）：改用带外结构化信号（进程退出码 / --junitxml / --json）重新接回。
//
// 依据 chapter2.md:847「模型几乎无条件地相信状态栏……越过这条线，
// 带着错状态栏可能**比不带还糟**」——已越线，删除严格优于现状。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dao-no-inferred-"));
const AS = require(path.join(__dirname, "..", "vendor/外接api/core/agent_status.js"));

const P = "\x1b[32mPASS\x1b[0m", F = "\x1b[31mFAIL\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { bad++; console.log(`${F}  ${desc}\n      got=${JSON.stringify(got)}`); }
  else console.log(`${P}  ${desc}`);
}

const cfg = { daoRoutes: { agentStatus: { enabled: true, defaultMode: "on" } } };
function run(toolOutput, command) {
  const key = "ni:" + Math.random();
  return AS.prepareOutbound({
    key,
    cfg,
    messages: [
      { role: "user", content: "跑一下测试" },
      { role: "assistant", tool_calls: [{ id: "t", function: { name: "exec", arguments: JSON.stringify({ command: command || "node test/foo.test.js" }) } }] },
      { role: "tool", tool_call_id: "t", name: "exec", content: toolOutput },
    ],
  });
}

console.log("=== A. 自由文本再也不能产生测试结论 ===");
// 这些输入以前都会写出 latest_test_status / failed_tests
const POISON = [
  ["含 failed 标识符的全绿输出", "PASS  B-2: failedTests 不含裸栈帧\n✅ 全部通过"],
  ["我自己的探针打印", "含 failed 字样吗? false\n含 failedTests 标识符吗? true"],
  ["解释 bug 的注释", "字样，被 failRe 抓成失败条目"],
  ["Node 崩溃栈", "node:internal/assert/utils:146\n  throw error;\nExit code: 1"],
  ["真实的 pytest 失败摘要", "3 failed, 9 passed in 2.41s"],
  ["真实的 jest 通过摘要", "Tests:       12 passed, 12 total"],
];
for (const [desc, body] of POISON) {
  const st = run(body).state;
  check(`A: ${desc} → 无 verification 段`, st.verification, undefined);
}

console.log("\n=== B. 由它派生的布尔结论一并消失 ===");
const st1 = run("3 failed, 9 passed").state;
check("B-1: 不再有 verification_blocking", st1.conclusions.verificationBlocking, undefined);
check("B-2: canClaimComplete 不被文本影响", st1.conclusions.canClaimComplete, (v) => typeof v === "boolean");

console.log("\n=== C. strategy 不再出现假的测试建议 ===");
for (const [desc, body] of POISON) {
  const st = run(body).state;
  const joined = (st.strategy || []).join(" ");
  check(`C: ${desc} → strategy 无 failing tests 指令`, joined, (s) =>
    !/failing tests|Verification has not passed/i.test(s));
}

console.log("\n=== D. 渲染出来的状态栏不含这些字段 ===");
const bar = AS.renderStatusBar(run("3 failed, 9 passed").state);
check("D-1: 不含 latest_test_status", bar, (b) => !/latest_test_status/.test(b));
check("D-2: 不含 failed_tests", bar, (b) => !/failed_tests/.test(b));
check("D-3: 不含 verification_blocking", bar, (b) => !/verification_blocking/.test(b));
check("D-4: 不含 test_runs", bar, (b) => !/test_runs/.test(b));

console.log("\n=== E. 反例：真实观测得来的读数必须保留 ===");
// 这些字段的值来自计数器/带外元数据，不是解析文本，属于书里认可的那一类
const st2 = run("whatever output").state;
check("E-1: 保留 totalToolCalls（计数器）", st2.execution.totalToolCalls, 1);
check("E-2: 保留 lastTool（带外）", st2.execution.lastTool, "exec");
check("E-3: 保留 lastToolOk（带外元数据）", st2.execution.lastToolOk, true);
check("E-4: 保留 cwd/os（真实观测）", st2.environment.os, process.platform);
check("E-5: 保留 goal（用户输入）", st2.goal, "跑一下测试");
check("E-6: 保留 route（带外）", st2.route !== undefined, true);

console.log("\n=== F. 带外错误元数据仍然可信 ===");
const key = "ni-err";
const st3 = AS.prepareOutbound({
  key, cfg,
  messages: [
    { role: "user", content: "跑一下" },
    { role: "assistant", tool_calls: [{ id: "e", function: { name: "exec", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "e", name: "exec", content: "boom", is_error: true },
  ],
}).state;
check("F-1: is_error=true → lastToolOk false", st3.execution.lastToolOk, false);
check("F-2: 记录 lastError", st3.execution.lastError !== null, true);

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad ? 1 : 0);
