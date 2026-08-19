"use strict";

// 验证 revproxy loadConfig 的 mtime 内存缓存: 命中返回同引用, saveConfig 后失效。

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-cfgcache-"));
const cfgPath = path.join(tempHome, "revproxy.json");

const revproxy = require("../vendor/外接api/core/revproxy.js");

try {
  revproxy.configure({ configPath: cfgPath });

  // 首次 load: 文件不存在 → 生成 apiKey 落盘
  const first = revproxy.loadConfig();
  assert.ok(first.apiKey, "first load generates apiKey");
  assert.ok(fs.existsSync(cfgPath), "config persisted to disk");

  // 连续两次 load 命中缓存 → 同一对象引用 (未改盘)
  const a = revproxy.loadConfig();
  const b = revproxy.loadConfig();
  assert.strictEqual(a, b, "cache hit returns identical reference");

  // saveConfig 改动 → 缓存刷新, 下次 load 反映新值
  const changed = Object.assign({}, a, { exactCache: { enabled: true, ttlMs: 123456 } });
  revproxy.saveConfig(changed);
  const afterSave = revproxy.loadConfig();
  assert.strictEqual(
    afterSave.exactCache.ttlMs,
    123456,
    "loadConfig reflects saved change (cache refreshed on save)",
  );

  // 外部直接改盘 (mtime 变) → 缓存失效, 读到新值
  // 用不同 mtime 保证失效判定 (statSync mtimeMs 精度足够, 写入即变)
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  raw.defaultMaxTokens = 9999;
  const future = new Date(Date.now() + 5000);
  fs.writeFileSync(cfgPath, JSON.stringify(raw));
  fs.utimesSync(cfgPath, future, future);
  const afterExternal = revproxy.loadConfig();
  assert.strictEqual(
    afterExternal.defaultMaxTokens,
    9999,
    "external edit (mtime change) invalidates cache",
  );

  // outboundRedact: null 不得抹掉默认对象 (否则 enabled === true 永失败)
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ apiKey: "dao-local-testkey0001", outboundRedact: null, exactCache: "bad" }),
  );
  const future2 = new Date(Date.now() + 10000);
  fs.utimesSync(cfgPath, future2, future2);
  const coerced = revproxy.loadConfig();
  assert.ok(coerced.outboundRedact && typeof coerced.outboundRedact === "object");
  assert.strictEqual(coerced.outboundRedact.enabled, false);
  assert.ok(coerced.exactCache && typeof coerced.exactCache === "object");
  assert.strictEqual(coerced.exactCache.enabled, false);

  console.log("revproxy config cache selftest: PASS");
} finally {
  revproxy.configure({});
  fs.rmSync(tempHome, { recursive: true, force: true });
}
