"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sourcePath = path.join(__dirname, "../vendor/bundled-origin/source.js");
const source = require("../vendor/bundled-origin/source");

const test = source._test;
const message = (field, payload) =>
  Buffer.concat([
    test._pbTag(field, 2),
    test._pbEncVarint(payload.length),
    payload,
  ]);
const string = (field, value) => message(field, Buffer.from(value, "utf8"));

const details = Buffer.concat([
  string(1, "GPT-5.6 Sol Medium"),
  string(2, "gpt-5.6"),
  string(3, "GPT-5.6"),
]);
const template = Buffer.concat([
  string(22, "gpt-5-6-sol-medium"),
  message(23, details),
]);
const container = message(1, template);
const userRecord = message(33, container);
const input = message(1, userRecord);

const injectStats = {};
const injected = test._pbInjectNewArchitectureModels(
  input,
  [{ uid: "dao", label: "dao", famUid: "dao", famLabel: "dao" }],
  injectStats,
);
const availableStats = { added: 0 };
const output = test._pbEnsureModelsAvailable(injected, availableStats);

const top = test.parseProto(output);
const user = test.parseProto(top[1][0].b);
const models = test.parseProto(user[33][0].b)[1].map((entry) => entry.b);
const uids = models.map((entry) => test._pbReadStringField(entry, 22));

assert.strictEqual(injectStats.injected_count, 1);
assert.deepStrictEqual(uids, ["gpt-5-6-sol-medium", "dao"]);
assert.ok(models.every((entry) => test.parseProto(entry)[20][0].v === 1));
assert.strictEqual(availableStats.total, 2);

const teamSettingsInput = Buffer.concat([
  string(1, "preserve-me"),
  string(7, "claude-opus-5-medium"),
  string(7, "dao-opus-5"),
  string(30, "subagent-default"),
]);
const teamSettingsStats = {};
const teamSettingsOutput = test._pbInjectCliTeamSettingsModelUids(
  teamSettingsInput,
  ["dao-opus-5", "dao-gpt-5-6-sol", "dao-mimo-v2-5"],
  teamSettingsStats,
);
const teamSettingsFields = test.parseProto(teamSettingsOutput);
const teamSettingsUids = teamSettingsFields[7].map((entry) => entry.b.toString("utf8"));
assert.strictEqual(teamSettingsStats.injected_count, 2);
assert.deepStrictEqual(teamSettingsUids, [
  "claude-opus-5-medium",
  "dao-opus-5",
  "dao-gpt-5-6-sol",
  "dao-mimo-v2-5",
]);
assert.equal(teamSettingsFields[1][0].b.toString("utf8"), "preserve-me");
assert.equal(teamSettingsFields[30][0].b.toString("utf8"), "subagent-default");
assert.deepStrictEqual(
  test._pbInjectCliTeamSettingsModelUids(teamSettingsOutput, ["dao-gpt-5-6-sol"]),
  teamSettingsOutput,
  "Team Settings injection must be idempotent",
);

const sourceText = fs.readFileSync(sourcePath, "utf8");
assert.match(
  sourceText,
  /\(\?:GetUserStatus\|GetCliTeamSettings\)/,
  "ACP team settings must use the protobuf model catalog injector",
);
assert.match(
  sourceText,
  /GetCliTeamSettings[\s\S]{0,240}_dump_cts/,
  "Team Settings capture must be bound to its own RPC response",
);

const selectionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dao-acp-selection-"));
const selectionPath = path.join(selectionRoot, "selection.json");
try {
  fs.writeFileSync(
    selectionPath,
    JSON.stringify({
      sessions: {
        "session-a": "dao-gpt-5-6-terra",
        "session-b": "dao-opus-5",
      },
    }),
  );
  assert.equal(
    test._daoAcpMountedModelUid(
      "swe-1-6-slow",
      { "x-dao-acp-session": "session-a" },
      selectionPath,
    ),
    "dao-gpt-5-6-terra",
    "the ACP mount model must resolve only the session key present in its request",
  );
  assert.equal(
    test._daoAcpMountedModelUid(
      "swe-1-6-slow",
      { "x-dao-acp-session": "session-b" },
      selectionPath,
    ),
    "dao-opus-5",
    "a second session must retain its independent Dao model selection",
  );
  assert.equal(
    test._daoAcpMountedModelUid(
      "swe-1-6-slow",
      {},
      selectionPath,
    ),
    "",
    "a request without a session key must never inherit another session's Dao model",
  );
  assert.equal(
    test._daoAcpMountedModelUid(
      "swe-1-6-slow",
      { "x-dao-acp-session": "session-a,session-b" },
      selectionPath,
    ),
    "",
    "an ambiguous request must not select either session's Dao model",
  );
  // Devin 两个挂载模型均会发推理。若只改写 slow, 以 fast 进来的请求就绕过
  // per-session BYOK, 落 fast 自己的降级链首选 —— 实证为"选 terra 却出 luna"。
  assert.equal(
    test._daoAcpMountedModelUid(
      "swe-1-6-fast",
      { "x-dao-acp-session": "session-a" },
      selectionPath,
    ),
    "dao-gpt-5-6-terra",
    "every ACP mount model must honour the session's own BYOK selection",
  );
  // Cascade/本地补全也走 swe-1-6-fast, 但不带 ACP session 头。
  // 无头即返空 · 其路由不得因本改动而变。
  assert.equal(
    test._daoAcpMountedModelUid("swe-1-6-fast", {}, selectionPath),
    "",
    "non-ACP traffic on a mount model must keep its own routing",
  );
  assert.equal(
    test._daoAcpMountedModelUid(
      "claude-opus-5-high",
      { "x-dao-acp-session": "session-a" },
      selectionPath,
    ),
    "",
    "only ACP mount models may be remapped",
  );
  fs.writeFileSync(
    selectionPath,
    JSON.stringify({ sessions: { "session-a": "untrusted-model" } }),
  );
  assert.equal(
    test._daoAcpMountedModelUid(
      "swe-1-6-slow",
      { "x-dao-acp-session": "session-a" },
      selectionPath,
    ),
    "",
    "invalid persisted selections must not change routing",
  );
} finally {
  fs.rmSync(selectionRoot, { recursive: true, force: true });
}
console.log("model unlock new schema selftest: PASS");
process.exit(0);
