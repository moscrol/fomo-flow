const path = require("path");
const AS = require(path.join(__dirname, "..", "vendor/外接api/core/agent_status.js"));

// 本会话真实注入形状（<system_info> 在最前，cwd 标在括号里）
const REAL_INJECT = [
  "<system_info>",
  "The following information is automatically generated context about your current environment.",
  "Current workspace directories:",
  "  /Users/a77 (cwd)",
  "  /Users/a77/agent-memory",
  "  /Users/a77/dao-proxy-pro",
  "",
  "Platform: macos",
  "OS Version: Darwin 25.4.0",
  "Today's date: Tuesday, 2026-08-11",
  "</system_info>",
  "我是让dao flow去注入的应该，你检查下，然后根据检索源提到的来优化",
].join("\n");

function prep(userContent) {
  const key = "gc:" + Math.random();
  AS.clear && AS.clear(key);
  const r = AS.prepareOutbound({
    key,
    messages: [{ role: "user", content: userContent }],
    workspaceRoots: [],          // ACP/多根工作区下就是空的
    cfg: null,
  });
  return r.state || {};
}

const P = "\x1b[32mPASS\x1b[0m", F = "\x1b[31mFAIL\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { bad++; console.log(`${F}  ${desc}\n      got=${JSON.stringify(got)}`); }
  else console.log(`${P}  ${desc}`);
}

console.log("=== A. goal 不再被注入块占满 ===");
const s1 = prep(REAL_INJECT);
check("goal 不含 <system_info>", s1.goal, (g) => !/system_info/i.test(g || ""));
check("goal 不以 'The following information' 开头", s1.goal, (g) => !/^The following information/i.test(g || ""));
check("goal 命中真实用户诉求", s1.goal, (g) => (g || "").includes("dao flow"));

console.log("\n=== B. cwd 从注入块里提取（workspaceRoots 为空）===");
check("cwd = /Users/a77", s1.environment && s1.environment.cwd, "/Users/a77");
check("不再触发 unknown-cwd 告警", (s1.strategy || []).join(" "), (s) => !/Working directory is unknown/.test(s));

console.log("\n=== C. 边界：注入块被截断（未闭合）也要清干净 ===");
const s2 = prep("<system_info>\nCurrent workspace directories:\n  /tmp/x (cwd)\nPlatform: macos\nToday's date: Tue");
check("未闭合块 → goal 为空而非半截 XML", s2.goal, (g) => !/system_info|Platform:/i.test(g || ""));
check("未闭合块仍能取到 cwd", s2.environment && s2.environment.cwd, "/tmp/x");

console.log("\n=== D. 反例：纯用户消息不受影响（防清洗过度）===");
const s3 = prep("帮我把 hook 的相对路径改成绝对路径");
check("普通 goal 原样保留", s3.goal, "帮我把 hook 的相对路径改成绝对路径");
check("无注入块时 cwd 仍为空（不臆造）", s3.environment && s3.environment.cwd, "");

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad ? 1 : 0);
