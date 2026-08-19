"use strict";

const assert = require("node:assert");
const { resolveUpstream, revproxyKeyPath } = require("../vendor/外接api/core/acp_upstream");

(async () => {
  // ── 显式 DAO_ACP_BASE_URL 优先, 不触发自动发现 ──
  {
    let discovered = false;
    const r = await resolveUpstream({
      env: { DAO_ACP_BASE_URL: "http://x/v1/", DAO_ACP_API_KEY: "explicit", DAO_ACP_MODEL: "m" },
      selectEndpoint: async () => { discovered = true; return "http://127.0.0.1:9/"; },
      readKeyFile: () => "filekey",
    });
    assert.strictEqual(r.baseUrl, "http://x/v1", "explicit base wins & trailing slash trimmed");
    assert.strictEqual(r.apiKey, "explicit", "explicit key wins");
    assert.strictEqual(r.model, "m");
    assert.strictEqual(discovered, false, "no discovery when base explicit");
  }

  // ── 无显式 base → 自动发现本地反代, 拼 /v1; key 读文件; model 默认 ──
  {
    const r = await resolveUpstream({
      env: {},
      selectEndpoint: async () => "http://127.0.0.1:8937",
      readKeyFile: () => "dao-local-abc",
    });
    assert.strictEqual(r.baseUrl, "http://127.0.0.1:8937/v1", "discovered base + /v1");
    assert.strictEqual(r.apiKey, "dao-local-abc", "key from revproxy.json");
    assert.strictEqual(r.model, "fomo-flow", "default model");
  }

  // ── 发现失败(空)→ baseUrl 空(降级为未配置提示) ──
  {
    const r = await resolveUpstream({ env: {}, selectEndpoint: async () => "" });
    assert.strictEqual(r.baseUrl, "", "no endpoint → empty base");
  }

  // ── 发现抛错被吞 → 空 base, 不崩 ──
  {
    const r = await resolveUpstream({ env: {}, selectEndpoint: async () => { throw new Error("boom"); } });
    assert.strictEqual(r.baseUrl, "");
  }

  // ── env key 优先于文件 key ──
  {
    const r = await resolveUpstream({
      env: { DAO_ACP_API_KEY: "envkey" },
      selectEndpoint: async () => "http://127.0.0.1:8937",
      readKeyFile: () => "filekey",
    });
    assert.strictEqual(r.apiKey, "envkey");
  }

  // ── 读 key 文件抛错被吞 ──
  {
    const r = await resolveUpstream({
      env: {},
      selectEndpoint: async () => "http://127.0.0.1:8937",
      readKeyFile: () => { throw new Error("no file"); },
    });
    assert.strictEqual(r.apiKey, "");
  }

  assert.ok(typeof revproxyKeyPath() === "string", "revproxyKeyPath returns string");

  console.log("acp upstream selftest: PASS");
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
