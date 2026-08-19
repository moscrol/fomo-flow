"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-project-prompt-"));
process.env.DAO_CUSTOM_SP_FILE = path.join(tempDir, "custom-sp.json");

const origin = require("../vendor/bundled-origin/source.js");

try {
const officialPrompt = [
  "You are Cascade, a powerful agentic AI coding assistant.",
  "<tool_calling>tool definitions that must not leak into strict project mode</tool_calling>",
  "<user_information>Windows 11</user_information>",
  "<workspace_information>E:\\workspace</workspace_information>",
  "You have tools available and should complete the task.",
  "Official prompt filler ".repeat(30),
].join("\n");
const projectPrompt = "PROJECT PROMPT ONLY\n第二行项目规则";

assert.strictEqual(origin.isLikelyOfficialSP(officialPrompt), true);

origin.setCustomSP(projectPrompt, {
  keep_blocks: false,
  source: "strict:test",
});
const defaultOverlay = origin.invertSP(officialPrompt);
assert.ok(defaultOverlay.startsWith(officialPrompt));
assert.ok(defaultOverlay.includes("<dao_custom_instructions>"));
assert.ok(defaultOverlay.includes(projectPrompt));
assert.strictEqual(origin.invertAnySP(officialPrompt), defaultOverlay);

origin.setCustomSP(projectPrompt, {
  keep_blocks: false,
  replace_all: true,
  source: "strict:test",
});
assert.strictEqual(origin.invertSP(officialPrompt), projectPrompt);
assert.strictEqual(origin.invertAnySP(officialPrompt), projectPrompt);

origin.setCustomSP(projectPrompt, {
  keep_blocks: true,
  source: "legacy-custom:test",
});
const compatibleResult = origin.invertSP(officialPrompt);
assert.ok(compatibleResult.startsWith(officialPrompt));
assert.ok(compatibleResult.includes("<tool_calling>"));

origin.clearCustomSP();
origin._test._injectProjectPrompt({
  id: "project-native-contract",
  name: "Native contract project",
  prompt: projectPrompt,
  projectPath: "E:\\workspace",
});
const injectedProjectResult = origin.invertSP(officialPrompt);
assert.ok(injectedProjectResult.startsWith(officialPrompt));
assert.ok(injectedProjectResult.includes(projectPrompt));
assert.ok(injectedProjectResult.includes("<tool_calling>"));
assert.ok(injectedProjectResult.includes("<workspace_information>"));
assert.strictEqual(
  (injectedProjectResult.match(/<tool_calling>/g) || []).length,
  1,
  "the native tool contract must be retained exactly once",
);
assert.strictEqual(
  injectedProjectResult.includes("You are Cascade"),
  true,
  "the complete Devin identity and execution contract must be preserved",
);
assert.strictEqual(
  (injectedProjectResult.match(/<dao_project_instructions>/g) || []).length,
  1,
  "the selected project prompt must be added as one stable overlay",
);
assert.strictEqual(
  origin.invertSP(injectedProjectResult),
  null,
  "an already-overlaid prompt must not receive a duplicate project block",
);
assert.strictEqual(origin._test._getProjectPromptState().customSP.keep_blocks, true);
assert.strictEqual(origin._test._getProjectPromptState().customSP.project_overlay, true);

const nativeToolDefinition = origin.serializeProto({
  1: [{ w: 2, b: Buffer.from("create_memory", "utf8") }],
  2: [{ w: 2, b: Buffer.from("Devin native tool contract", "utf8") }],
});
const nativeSideChannel = Buffer.from(
  "<conversation_summary>retain official context</conversation_summary>",
  "utf8",
);
const rawRequest = origin.buildFrame(
  0,
  origin.serializeProto({
    3: [{ w: 2, b: Buffer.from(officialPrompt, "utf8") }],
    10: [{ w: 2, b: nativeToolDefinition }],
    11: [{ w: 2, b: nativeSideChannel }],
  }),
);
const modifiedRawRequest = origin.modifyRawSP(rawRequest);
const modifiedRawFields = origin.parseProto(origin.parseFrames(modifiedRawRequest)[0].payload);
assert.strictEqual(
  Buffer.compare(Buffer.from(modifiedRawFields[10][0].b), nativeToolDefinition),
  0,
  "project prompt injection must not rewrite or remove Devin tool definitions",
);
assert.strictEqual(
  Buffer.compare(Buffer.from(modifiedRawFields[11][0].b), nativeSideChannel),
  0,
  "project prompt injection must not strip Devin conversation summaries",
);

origin.clearCustomSP();
fs.rmSync(tempDir, { recursive: true, force: true });

console.log("project prompt strict replacement: ok");
process.exit(0);
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
