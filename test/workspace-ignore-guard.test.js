"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const guard = require("../workspace_ignore_guard");

const normalized = guard.normalizeCodeiumIgnore(
  "Library/\r\nTemp/\r\nAssets/Library/\r\n**/bin/\r\n",
);
assert.equal(normalized.changed, true);
assert.equal(
  normalized.content,
  "/Library/\r\nTemp/\r\nAssets/Library/\r\n**/bin/\r\n",
);

const alreadySafe = guard.normalizeCodeiumIgnore(
  "/Library/\nTemp/\n# Library/ stays in a comment\n",
);
assert.equal(alreadySafe.changed, false);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dao-codeiumignore-"));
try {
  const ignorePath = path.join(root, ".codeiumignore");
  fs.writeFileSync(ignorePath, "Library/\nTemp/\n", "utf8");

  const first = guard.repairWorkspaceIgnoreFile(root);
  assert.equal(first.changed, true);
  assert.equal(fs.readFileSync(ignorePath, "utf8"), "/Library/\nTemp/\n");

  const firstMtime = fs.statSync(ignorePath).mtimeMs;
  const second = guard.repairWorkspaceIgnoreFile(root);
  assert.equal(second.changed, false);
  assert.equal(second.reason, "clean");
  assert.equal(fs.statSync(ignorePath).mtimeMs, firstMtime);

  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dao-no-ignore-"));
  try {
    const missing = guard.repairWorkspaceIgnoreFile(missingRoot);
    assert.equal(missing.changed, false);
    assert.equal(missing.reason, "missing");
  } finally {
    fs.rmSync(missingRoot, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("workspace ignore guard: PASS");
