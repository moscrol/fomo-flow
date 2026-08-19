const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  PRODUCT,
  stateDir,
  legacyStateDir,
  resolveStateDir,
  migrateStateDirOnce,
  stateFile,
} = require("../core/product_identity");

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fomo-identity-"));
}

test("product identity is FOMO FLOW", () => {
  assert.equal(PRODUCT.displayName, "FOMO FLOW");
  assert.equal(PRODUCT.packageName, "fomo-flow");
  assert.equal(PRODUCT.publisher, "fomoflow");
  assert.equal(PRODUCT.extensionId, "fomoflow.fomo-flow");
  assert.equal(PRODUCT.commandPrefix, "fomo");
  assert.equal(PRODUCT.configPrefix, "fomo");
});

test("prefers existing ~/.fomo-flow over a prior local state directory", () => {
  const home = makeHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.mkdirSync(legacyStateDir(home), { recursive: true });
  assert.equal(resolveStateDir(home), stateDir(home));
});

test("falls back to a prior local state directory when ~/.fomo-flow is absent", () => {
  const home = makeHome();
  fs.mkdirSync(legacyStateDir(home), { recursive: true });
  assert.equal(resolveStateDir(home), legacyStateDir(home));
});

test("copies a prior local state directory once and leaves the source bytes", () => {
  const home = makeHome();
  const legacy = legacyStateDir(home);
  fs.mkdirSync(legacy, { recursive: true });
  const bytes = '{"provider":"fixture"}\n';
  fs.writeFileSync(path.join(legacy, "配置.json"), bytes);
  const first = migrateStateDirOnce(home);
  assert.equal(first.migrated, true);
  assert.equal(fs.readFileSync(path.join(first.dest, "配置.json"), "utf8"), bytes);
  assert.equal(fs.readFileSync(path.join(legacy, "配置.json"), "utf8"), bytes);
  assert.equal(resolveStateDir(home), stateDir(home));
  assert.equal(stateFile("配置.json", home), path.join(stateDir(home), "配置.json"));
  const second = migrateStateDirOnce(home);
  assert.equal(second.migrated, false);
});
