"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const codex = require("../vendor/外接api/core/codex_hot_route.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-tool-surface-"));

function writeCatalog(name, toolMode, lite) {
  fs.writeFileSync(
    path.join(dir, name),
    JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          tool_mode: toolMode,
          use_responses_lite: lite,
        },
      ],
    }),
  );
}

// ── normalizeToolSurface ──
assert.strictEqual(codex.normalizeToolSurface("classic-forced"), "classic-forced");
assert.strictEqual(codex.normalizeToolSurface("catalog-passthrough"), "catalog-passthrough");
assert.strictEqual(codex.normalizeToolSurface("passthrough"), "catalog-passthrough");
assert.strictEqual(codex.normalizeToolSurface(""), "classic-forced");
assert.strictEqual(codex.normalizeToolSurface("bogus"), "classic-forced");

// ── applyClassicToolSurface ──
{
  const m = {
    tool_mode: "code_mode_only",
    use_responses_lite: true,
  };
  codex.applyClassicToolSurface(m);
  assert.strictEqual(m.tool_mode, "direct");
  assert.strictEqual(m.use_responses_lite, false);
  assert.strictEqual(m.shell_type, "shell_command");
  assert.strictEqual(m.apply_patch_tool_type, "freeform");
}

// ── ensureDirectToolCatalogs classic-forced ──
{
  writeCatalog("cockpit-local-access-model-catalog.json", "code_mode_only", true);
  writeCatalog("dao-codex-model-catalog.json", "code_mode_only", true);
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    [
      'model_catalog_json = "cockpit-local-access-model-catalog.json"',
      "[features]",
      "code_mode_host = true",
      "code_mode = true",
      "apply_patch_freeform = false",
      "",
    ].join("\n"),
  );
  const r = codex.ensureDirectToolCatalogs({
    codexHome: dir,
    configPath: path.join(dir, "config.toml"),
    toolSurface: "classic-forced",
  });
  assert.strictEqual(r.skipped, false);
  assert.ok(r.catalogsFixed.length >= 1);
  const fixed = JSON.parse(
    fs.readFileSync(path.join(dir, "cockpit-local-access-model-catalog.json"), "utf8"),
  );
  assert.strictEqual(fixed.models[0].tool_mode, "direct");
  assert.strictEqual(fixed.models[0].use_responses_lite, false);
  const cfg = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
  assert.match(cfg, /dao-codex-model-catalog\.json/);
  assert.match(cfg, /code_mode_host = false/);
}

// ── ensureDirectToolCatalogs passthrough skips ──
{
  writeCatalog("cockpit-local-access-model-catalog.json", "code_mode_only", true);
  const r = codex.ensureDirectToolCatalogs({
    codexHome: dir,
    configPath: path.join(dir, "config.toml"),
    toolSurface: "catalog-passthrough",
  });
  assert.strictEqual(r.skipped, true);
  const left = JSON.parse(
    fs.readFileSync(path.join(dir, "cockpit-local-access-model-catalog.json"), "utf8"),
  );
  assert.strictEqual(left.models[0].tool_mode, "code_mode_only");
}

// ── probeCodexToolSurfaceHealth critical ──
{
  writeCatalog("dao-codex-model-catalog.json", "code_mode_only", true);
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    [
      'model_catalog_json = "dao-codex-model-catalog.json"',
      "[features]",
      "code_mode_host = false",
      "",
    ].join("\n"),
  );
  const h = codex.probeCodexToolSurfaceHealth({
    codexHome: dir,
    configPath: path.join(dir, "config.toml"),
    toolSurface: "catalog-passthrough",
  });
  assert.strictEqual(h.state, "critical");
  assert.strictEqual(h.zeroToolRisk, true);
  assert.strictEqual(h.reason, "code_mode_without_host");
}

// ── probe ok under classic-forced after pin ──
{
  writeCatalog("dao-codex-model-catalog.json", "direct", false);
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    [
      'model_catalog_json = "dao-codex-model-catalog.json"',
      "[features]",
      "code_mode_host = false",
      "",
    ].join("\n"),
  );
  const h = codex.probeCodexToolSurfaceHealth({
    codexHome: dir,
    configPath: path.join(dir, "config.toml"),
    toolSurface: "classic-forced",
  });
  assert.strictEqual(h.state, "ok");
  assert.strictEqual(h.zeroToolRisk, false);
}

console.log("codex tool surface: PASS");
