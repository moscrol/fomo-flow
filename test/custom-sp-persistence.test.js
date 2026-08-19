"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-custom-sp-"));
const legacyPath = path.join(tempDir, "legacy-custom-sp.json");
const userPath = path.join(tempDir, "dao-byok", "custom-sp.json");
const legacy = {
  sp: "项目根目录：E:\\新增运行时状态机\n按项目规则执行。",
  keep_blocks: false,
  replace_all: true,
  source: "project:runtime-state-machine",
  project_id: "runtime-state-machine",
  project_name: "新增运行时状态机",
  project_path: "E:\\新增运行时状态机",
  at: Date.now(),
};
fs.writeFileSync(legacyPath, JSON.stringify(legacy), "utf8");
process.env.DAO_LEGACY_CUSTOM_SP_FILE = legacyPath;
process.env.DAO_CUSTOM_SP_FILE = userPath;
process.env.DAO_PROJECT_PROMPTS_FILE = path.join(tempDir, "project-prompts.json");

const source = require("../vendor/bundled-origin/source");

assert.strictEqual(source._test._customSPFile, userPath);
assert.strictEqual(source._test._legacyCustomSPFile, legacyPath);
assert.ok(fs.existsSync(userPath), "legacy prompt should migrate into user storage");
assert.deepStrictEqual(JSON.parse(fs.readFileSync(userPath, "utf8")), legacy);
assert.strictEqual(source._test._getProjectPromptState().customSP.project_id, legacy.project_id);

assert.strictEqual(source.clearCustomSP(), true);
const cleared = JSON.parse(fs.readFileSync(userPath, "utf8"));
assert.strictEqual(cleared.disabled, true, "clear should persist a tombstone");
assert.strictEqual(
  source._test._loadCustomSP(),
  null,
  "a tombstone must prevent an old extension directory from restoring a cleared prompt",
);

assert.strictEqual(
  source.setCustomSP("persistent custom prompt", {
    keep_blocks: false,
    source: "test",
  }),
  true,
);
const saved = JSON.parse(fs.readFileSync(userPath, "utf8"));
assert.strictEqual(saved.sp, "persistent custom prompt");
assert.strictEqual(saved.keep_blocks, false);
assert.strictEqual(saved.source, "test");

console.log("custom SP persistence selftest: PASS");
process.exit(0);
