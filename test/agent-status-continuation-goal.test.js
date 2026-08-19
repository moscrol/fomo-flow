"use strict";
// Devin Local 续写会话的第一条 user 消息是 harness 摘要，不是用户诉求。
// 形状（本会话实测，2026-08-16）：
//   You are continuing work from a previous conversation thread.
//   Below is a summary of the previous conversation thread:
//   ...
// _firstUserGoal 取第一条「有人话资格」的行，白名单认它（≥2 个拉丁词），
// 于是 goal 钉死在摘要开头。observeMessages 只在 !state.goal 时重算，
// 脏值会一直注入给模型。
//
// 桌面 HUD 已滤掉同一前缀（dao-observation-source.ts / collaborationModel.ts），
// 但那只是给人看的投影；模型看见的仍是 agent_status.js 写进状态栏的 goal。
//
// 对照 ai-agent-book/book/chapter2.md:847：模型几乎无条件相信状态栏。
// 摘要不是用户任务，整条消息都应跳过，改抽后面第一条真人 user 话。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dao-cont-goal-"));
const AS = require(path.join(__dirname, "..", "vendor/外接api/core/agent_status.js"));

const P = "\x1b[32mPASS\x1b[0m";
const F = "\x1b[31mFAIL\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok =
    typeof want === "function"
      ? want(got)
      : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    bad++;
    console.log(`${F}  ${desc}\n      got=${JSON.stringify(got)}`);
  } else {
    console.log(`${P}  ${desc}`);
  }
}

const CONTINUATION = [
  "You are continuing work from a previous conversation thread. Below is a summary of the previous conversation thread:",
  "The user asked why a Devin Local session cannot switch models after it starts.",
  "The investigation later moved to GLM routing and selective merge.",
].join("\n");

function goalOf(messages) {
  const st = AS._emptyState("g" + Math.random());
  AS.observeMessages(st, messages, {});
  return st.goal;
}

console.log("=== A. 续写摘要不得占满 goal ===");
check(
  "A-1: 摘要后跟真人诉求 → 取真人话",
  goalOf([
    { role: "user", content: CONTINUATION },
    { role: "user", content: "status 之前的改动pr你找一下" },
  ]),
  "status 之前的改动pr你找一下",
);
check(
  "A-2: 只有摘要 → goal 为空，不谎报",
  goalOf([{ role: "user", content: CONTINUATION }]),
  "",
);
check(
  "A-3: Below is a summary 变体同样整条跳过",
  goalOf([
    {
      role: "user",
      content:
        "Below is a summary of the previous conversation thread:\n- looked at logs",
    },
    { role: "user", content: "继续" },
  ]),
  "继续",
);

console.log("\n=== B. 存量脏 goal 必须过闸门重算 ===");
check("B-1: STATE_SCHEMA 升到 4（goal 口径再变）", AS._emptyState("x")._schema, 4);

const key = "dao:cont-dirty-goal";
const old = AS._emptyState(key);
old._schema = 3;
old.mode = "on";
old.goal =
  "You are continuing work from a previous conversation thread. Below is a summary of the previous conversation thread:";
AS._save(old);
const migrated = AS.prepareOutbound({
  key,
  messages: [
    { role: "user", content: CONTINUATION },
    { role: "user", content: "读一下agent book里的status的官方设计" },
  ],
  cfg: { daoRoutes: { agentStatus: { enabled: true, defaultMode: "on" } } },
}).state;
check(
  "B-2: schema 3 脏 goal 被清掉并重算",
  migrated.goal,
  "读一下agent book里的status的官方设计",
);
check(
  "B-3: 注入正文不含续写摘要开头",
  (AS.renderStatusBar(migrated) || "").includes(
    "You are continuing work from a previous conversation thread",
  ),
  false,
);

console.log("\n=== C. 反例：正常人话不得被误伤 ===");
check(
  "C-1: 普通中文诉求原样保留",
  goalOf([{ role: "user", content: "帮我把 hook 的相对路径改成绝对路径" }]),
  "帮我把 hook 的相对路径改成绝对路径",
);
check(
  "C-2: 用户自己提到 previous conversation 仍算诉求",
  goalOf([
    {
      role: "user",
      content: "对比 previous conversation 里那次 GLM 路由，看映射改了没",
    },
  ]),
  "对比 previous conversation 里那次 GLM 路由，看映射改了没",
);

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad ? 1 : 0);
