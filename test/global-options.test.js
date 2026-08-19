"use strict";

// dao_router 全局选项(OTEL 导出 + Cascade 出站脱敏)热读写 —— 面板接线的后端核心。

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-globalopt-"));
const cfgPath = path.join(tempHome, "config.json");
fs.writeFileSync(
  cfgPath,
  JSON.stringify({
    providers: {
      provA: { enabled: true, apiKey: "k", baseUrl: "https://a/v1", models: ["m"], type: "openai-compatible" },
    },
    daoRoutes: { enabled: true, agentStatus: { enabled: false }, routes: { m: { provider: "provA", model: "m" } } },
  }),
  "utf8",
);

const router = require("../vendor/外接api/core/dao_router");

try {
  router.init({ log: () => {}, configPath: cfgPath });

  // 默认: 都关闭
  let opts = router.getGlobalOptions();
  assert.strictEqual(opts.otel.enabled, false, "otel disabled by default");
  assert.strictEqual(opts.outboundRedact.enabled, false, "redact disabled by default");
  assert.strictEqual(opts.outboundRedact.mode, "redact", "default mode redact");

  // 热设置
  const r = router.hotSetGlobalOptions({
    otel: { enabled: true, endpoint: "http://localhost:4318", serviceName: "svc-test" },
    outboundRedact: { enabled: true, mode: "monitor" },
  });
  assert.ok(r.ok, "hotSetGlobalOptions ok");

  opts = router.getGlobalOptions();
  assert.strictEqual(opts.otel.enabled, true);
  assert.strictEqual(opts.otel.endpoint, "http://localhost:4318");
  assert.strictEqual(opts.otel.serviceName, "svc-test");
  assert.strictEqual(opts.outboundRedact.enabled, true);
  assert.strictEqual(opts.outboundRedact.mode, "monitor");

  // 持久化到 config.json
  const persisted = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.strictEqual(persisted.otel.enabled, true, "otel persisted");
  assert.strictEqual(persisted.otel.endpoint, "http://localhost:4318");
  assert.strictEqual(persisted.outboundRedact.mode, "monitor", "redact persisted");

  // 非法 mode 被忽略, 保留旧值
  router.hotSetGlobalOptions({ outboundRedact: { mode: "bogus" } });
  assert.strictEqual(router.getGlobalOptions().outboundRedact.mode, "monitor", "invalid mode ignored");

  // 部分更新不清空其它字段
  router.hotSetGlobalOptions({ otel: { enabled: false } });
  opts = router.getGlobalOptions();
  assert.strictEqual(opts.otel.enabled, false, "otel toggled off");
  assert.strictEqual(opts.otel.endpoint, "http://localhost:4318", "endpoint preserved on partial update");

  console.log("global options selftest: PASS");
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}
process.exit(0);
