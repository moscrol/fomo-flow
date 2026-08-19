"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "extension.js"), "utf8");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `missing section: ${startMarker}`);
  return source.slice(start, end);
}

const setAnchorSource = section(
  "async function setAnchor(port, options = {})",
  "async function clearAnchor()",
);

assert.match(
  setAnchorSource,
  /if \(options\.restartLanguageServer === true\) \{\s*_maybeRestartLS\(/,
  "setAnchor restart must be explicit",
);

const activationSource = section(
  "if (_acpMode) {",
  "// ── v9.9.29 真治",
);
const startupAnchorCalls = activationSource.match(/setAnchor\(_cachedPort[^;]*;/gs) || [];

const acpActivationSource = section("if (_acpMode) {", "} else if (_cachedAnchored) {");
assert.doesNotMatch(
  acpActivationSource,
  /setAnchor\(/,
  "ACP startup must not write settings while the language server is starting",
);
assert.match(
  acpActivationSource,
  /仅内存锚定（不写 settings）/,
  "ACP startup must keep an in-memory anchor",
);
assert(startupAnchorCalls.length >= 2, "expected non-ACP activation anchor calls");
assert(
  startupAnchorCalls.some((call) => !call.includes("restartLanguageServer")),
  "startup anchor must preserve the LS already rewritten by the spawn hook",
);

assert.match(
  source,
  /fs\.promises\.unlink\(_CMD_FILE\)/,
  "IPC commands must be consumed once before execution",
);

const unlockHealSource = section(
  "async function ensureUnlockFlowing(attempt)",
  "// ★ 状态栏入口刷新",
);
assert.match(
  unlockHealSource,
  /_lsSpawnSeen && spawnAge < 90000/,
  "unlock heal must preserve a newly spawned language server",
);
assert.match(
  source,
  /_lastLsSpawnAt = Date\.now\(\);/,
  "language server spawn time must be tracked",
);

const acpWorkspaceSource = section(
  "function _acpEnvRegisterWorkspace(env)",
  "function _prepareAcpSpawnOptions(options, systemProxy)",
);
assert.match(
  acpWorkspaceSource,
  /vscode\.workspace\.workspaceFolders/,
  "ACP workspace registration must use the roots opened in the current Devin window",
);
assert.match(acpWorkspaceSource, /DAO_WORKSPACE_ROOTS = JSON\.stringify\(roots\)/);
assert.match(
  source,
  /arguments\[2\] = _prepareAcpSpawnOptions\(arguments\[2\], _sysProxy\)/,
  "ACP root registration must also cover spawn calls that omit options",
);

console.log("startup anchor selftest: PASS");
