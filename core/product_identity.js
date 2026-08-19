"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PRODUCT = Object.freeze({
  displayName: "FOMO FLOW",
  packageName: "fomo-flow",
  publisher: "fomoflow",
  extensionId: "fomoflow.fomo-flow",
  commandPrefix: "fomo",
  configPrefix: "fomo",
  desktopAppId: "com.fomoflow.desktop",
  desktopProductName: "FOMO FLOW",
  stateDirName: ".fomo-flow",
  legacyStateRel: Object.freeze([".codeium", "dao-byok"]),
  legacyDesktopName: "Dao Flow",
});

function homeDir(home) {
  return (
    home ||
    process.env.FOMO_HOME ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    os.homedir() ||
    ""
  );
}

function stateDir(home) {
  const root = homeDir(home);
  return root ? path.join(root, PRODUCT.stateDirName) : null;
}

function legacyStateDir(home) {
  const root = homeDir(home);
  return root ? path.join(root, ...PRODUCT.legacyStateRel) : null;
}

function resolveStateDir(home) {
  const dest = stateDir(home);
  const src = legacyStateDir(home);
  if (dest && fs.existsSync(dest)) return dest;
  if (src && fs.existsSync(src)) return src;
  return dest;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (typeof fs.cpSync === "function") {
    fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
    return;
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else if (!fs.existsSync(to)) fs.copyFileSync(from, to);
  }
}

function migrateStateDirOnce(home) {
  const dest = stateDir(home);
  const src = legacyStateDir(home);
  if (!dest) return { dest: null, migrated: false };
  if (fs.existsSync(dest)) return { dest, migrated: false };
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (src && fs.existsSync(src)) {
    copyDirRecursive(src, dest);
    fs.writeFileSync(
      path.join(dest, ".migrated-from-legacy.json"),
      `${JSON.stringify({ from: "prior-local-state", at: new Date().toISOString() })}\n`,
    );
    return { dest, migrated: true };
  }
  return { dest, migrated: false };
}

function stateFile(name, home) {
  const dir = resolveStateDir(home);
  return dir ? path.join(dir, name) : null;
}

module.exports = {
  PRODUCT,
  homeDir,
  stateDir,
  legacyStateDir,
  resolveStateDir,
  migrateStateDirOnce,
  stateFile,
};
