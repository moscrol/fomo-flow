"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const extensionSource = fs.readFileSync(
  path.join(__dirname, "..", "extension.js"),
  "utf8",
);
const functionStart = extensionSource.indexOf("function _isSelfUninstalling()");
const functionEnd = extensionSource.indexOf("function _codeiumHome()", functionStart);

assert(functionStart >= 0 && functionEnd > functionStart, "uninstall detector not found");

const detectorSource = extensionSource.slice(functionStart, functionEnd);
const currentDir = "dao-agi.dao-proxy-pro-9.9.372";

function detect(obsolete, extensionRegistered = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dao-uninstall-"));
  const extensionsRoot = path.join(root, "extensions");
  const extensionPath = path.join(extensionsRoot, currentDir);
  fs.mkdirSync(extensionPath, { recursive: true });
  fs.writeFileSync(
    path.join(extensionsRoot, ".obsolete"),
    JSON.stringify(obsolete),
    "utf8",
  );

  const context = {
    fs,
    path,
    _extContext: { extensionPath },
    SELF_EXT_ID: "dao-agi.dao-proxy-pro",
    vscode: {
      extensions: {
        getExtension: () => (extensionRegistered ? {} : undefined),
      },
    },
    result: null,
  };

  try {
    vm.runInNewContext(
      `${detectorSource}\nresult = _isSelfUninstalling();`,
      context,
    );
    return context.result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

assert.strictEqual(
  detect({ "dao-agi.dao-proxy-pro-9.9.366": true }),
  false,
  "old version cleanup must not uninstall the current version",
);
assert.strictEqual(
  detect({ [currentDir]: true }),
  true,
  "current directory marker must be treated as uninstall",
);
assert.strictEqual(detect({}), false, "normal shutdown must not be uninstall");
assert.strictEqual(
  detect({}, false),
  true,
  "missing extension registry entry remains an uninstall fallback",
);

console.log("uninstall detection selftest: PASS");
