const path = require("path");
const AS = require(path.join(__dirname, "..", "vendor/外接api/core/agent_status.js"));

// 构造一轮 assistant(tool_call) + tool(result) 的最小轨迹
function run(toolName, args, resultBody, isErrorFlag) {
  const st = AS._emptyState("mut:" + Math.random());
  const id = "c1";
  const msgs = [
    { role: "user", content: "做点事" },
    { role: "assistant", tool_calls: [{ id, function: { name: toolName, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] },
    Object.assign({ role: "tool", tool_call_id: id, name: toolName, content: resultBody },
                  isErrorFlag ? { is_error: true } : {}),
  ];
  AS.observeMessages(st, msgs, {});
  return {
    lastError: st.execution.lastError ? st.execution.lastError.type : null,
    lastToolOk: st.execution.lastToolOk,
    consecFail: st.execution.consecutiveFailures || {},
    // verification 段已删除（文本推断不可靠）。这里改成只检查执行层字段。
    verification: st.verification,
  };
}

const F = "\x1b[31mFAIL\x1b[0m", P = "\x1b[32mPASS\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? P : F}  ${desc}`);
  if (!ok) console.log(`      got=${JSON.stringify(got)}\n      want=${JSON.stringify(want)}`);
}

console.log("=== A. 该放行：本会话实测的三个假事实样本 ===");
check("read 返回 <file-view> 不记 lastError",
  run("read", { file_path: "/x/agent_status.js" },
      '<file-view path="/x/agent_status.js" start_line="467" end_line="496">\n  if (/ENOENT|no such file/i.test(t)) return "FileNotFound";\n</file-view>').lastError,
  null);

check("grep 命中源码 不记 lastError",
  run("grep", { pattern: "_errorType" },
      'Found 32 match(es) for pattern\n469|  if (/ENOENT|no such file/i.test(t)) return "FileNotFound";').lastError,
  null);

check("exec 跑 git diff（含 ENOENT 字面量）不记 lastError",
  run("exec", { command: "git diff --cached" },
      'Output from command in shell 288519:\ndiff --git a/core/agent_status.js b/core/agent_status.js\n+  if (/ENOENT|no such file/i.test(t)) return "FileNotFound";\n\nExit code: 0').lastError,
  null);

console.log("\n=== B. 读测试文件不产生任何测试结论 ===");
// 原本这里断言 testRuns=0 / testStatus="unknown"。A 阶段把整个 verification 段
// 删掉了，所以正确契约变成「字段不存在」——读测试文件本来就不该产生测试结论，
// 现在连产生的通道都没有了。
const r1 = run("read", { file_path: "/x/test/agent-status.test.js" }, "const assert = require('assert');\n// 一些测试源码");
check("read *.test.js 无 verification 段", r1.verification, undefined);
const r2 = run("grep", { pattern: "foo", path: "/x/tests/bar.spec.ts" }, "Found 3 match(es)\n12| describe('x', () => {");
check("grep tests/*.spec 无 verification 段", r2.verification, undefined);

console.log("\n=== C. 该拦：真实失败必须仍被抓到（防「宁可漏报」漏成瞎子）===");
check("真 traceback 仍记 RuntimeError",
  run("exec", { command: "python x.py" },
      'Traceback (most recent call last):\n  File "/x/y.py", line 12, in <module>\n    raise TypeError("boom")\nTypeError: boom\n\nExit code: 1', true).lastError,
  "RuntimeError");

check("真 command not found 仍记错",
  run("exec", { command: "pm2 restart" },
      'bash: pm2: command not found\n\nExit code: 127', true).lastError,
  "CommandNotFound");

// 真实 pytest 的失败/通过原本在这里断言 status=failed / passed。
// A 阶段删除后，这类信息暂时不再进状态栏——B 阶段将用带外结构化信号
// （进程退出码 / --junitxml / --json）重建，而不是继续解析 stdout。
// 现在只保留「带外错误元数据仍然可信」这一条，它不依赖文本解析。
const rp = run("exec", { command: ".venv/bin/python -m pytest -q" },
  "FAILED tests/test_a.py::test_one - assert 1 == 2\n1 failed, 30 passed\n\nExit code: 1", true);
check("真 pytest 失败：带外 is_error 仍记 lastToolOk=false", rp.lastToolOk, false);
check("真 pytest 失败：无 verification 段", rp.verification, undefined);

const rok = run("exec", { command: ".venv/bin/python -m pytest -q" }, "31 passed in 2.10s\n\nExit code: 0");
check("真 pytest 通过：无带外错误 → lastToolOk=true", rok.lastToolOk, true);
check("真 pytest 通过：无 verification 段", rok.verification, undefined);

// ── D. P0-1 新增：isError 带外元数据 vs 正文嗅探 ────────────────────────────
// 根因：772-778 行的 isError 判据包含正文嗅探，且在 _errorType 闸门之前计算。
// 后果：即使 is_error 未置位（工具成功），只要正文含 ENOENT/Traceback 字面量，
//       lastToolOk 被记成 false，consecutiveFailures 被累加，strategy 据此
//       给出"verify path"的误导建议。bce7388 只保护了 lastError 类型，没保护其余字段。
//
// 正确判据：is_error/tool_result_is_error（带外元数据，工具层设置，不含正文）才算真失败。
// 正文嗅探只用于给已知失败分类，不用于判断是否失败。

console.log("\n=== D. P0-1: isError 带外元数据 vs 正文嗅探（新增）===");

// D-1：读文件返回含「ENOENT」字面量的源码 → is_error 未置位 → 不算失败
const d1 = run("read", { file_path: "/x/agent_status.js" },
  '<file-view path="/x/agent_status.js">\nif (/ENOENT|no such file/i.test(t)) return "FileNotFound";\n</file-view>');
check("D-1: 读含 ENOENT 字面量的代码 → lastToolOk 应为 true", d1.lastToolOk !== false, true);
check("D-1: 读含 ENOENT 字面量的代码 → consecutiveFailures 应为 0",
  (d1.consecFail || {}).read || 0, 0);

// D-2：exec 输出含 Traceback 字面量但 exit 0 → is_error 未置位 → 不算失败
const d2 = run("exec", { command: "node /tmp/qc-repro.js" },
  'Output from command in shell x:\n' +
  '=== C: 该拦 ===\n  真 traceback lastError = RuntimeError\n\nExit code: 0');
check("D-2: exec 成功输出含 Traceback 字样 → lastToolOk 应为 true", d2.lastToolOk !== false, true);
check("D-2: exec 成功输出含 Traceback 字样 → consecutiveFailures 应为 0",
  (d2.consecFail || {}).exec || 0, 0);

// D-3：grep 输出含源码里的 ENOENT → is_error 未置位 → 不算失败
const d3 = run("grep", { pattern: "ENOENT|Traceback" },
  'Found 9 match(es) for pattern\n776|  /\\b(ENOENT|Traceback|Exception)\\b/i.test(body)');
check("D-3: grep 命中含错误模式的源码 → lastToolOk 应为 true", d3.lastToolOk !== false, true);

// D-4：真失败（is_error=true）仍应正确记录
const d4 = run("exec", { command: "cat missing.txt" },
  'ENOENT: no such file or directory\n\nExit code: 1', true);
check("D-4: 真失败 is_error=true → lastToolOk 应为 false", d4.lastToolOk !== false, false);
check("D-4: 真失败 → lastError 有值", d4.lastError !== null, true);

console.log(bad === 0 ? "\n✅ 全部变异通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad === 0 ? 0 : 1);
