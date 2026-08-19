"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const trace = require("../vendor/外接api/core/trace_center.js");
const alerts = require("../vendor/外接api/core/alert_center.js");
const history = require("../vendor/外接api/core/config_history.js");

// ── trace_center: 轨迹记录 · 步骤 · 回放顺序 ──
trace.clear();
const t1 = trace.begin({ modelUid: "MODEL_A" });
t1.step("attempt", { provider: "p1", model: "m1", source: "primary" });
t1.step("http_error", { provider: "p1", status: 429 });
t1.step("attempt_fallback", { provider: "p2", model: "m2", source: "auto-fallback" });
t1.end("ok", "p2/m2 (auto-fallback)");
const t2 = trace.begin({ modelUid: "MODEL_B" });
t2.end("failed", "全部渠道失败");

const recent = trace.recent(10);
assert.strictEqual(recent.length, 2, "两条 trace");
assert.strictEqual(recent[0].modelUid, "MODEL_B", "最新在前");
assert.strictEqual(recent[1].status, "ok");
assert.strictEqual(recent[1].steps.length, 3, "三个步骤");
assert.strictEqual(recent[1].steps[1].status, 429);
assert.ok(recent[1].durationMs >= 0, "有耗时");

// end 幂等
t1.end("failed", "should not overwrite");
assert.strictEqual(trace.recent(10)[1].status, "ok", "end 幂等");

// ── alert_center: 推送 · 去重 · since 游标 · 订阅 ──
alerts.clear();
const seen = [];
const unsub = alerts.subscribe((a) => seen.push(a.type));
const a1 = alerts.push({
  level: "error",
  type: "circuit_open",
  title: "渠道熔断",
  provider: "p1",
  model: "m1",
});
// 同 type+provider+model 短窗内去重 · count 累加
const a2 = alerts.push({ type: "circuit_open", provider: "p1", model: "m1" });
assert.strictEqual(a2.id, a1.id, "短窗去重");
assert.strictEqual(a2.count, 2, "去重计数累加");
alerts.push({ type: "route_failed", model: "MODEL_A" });
assert.deepStrictEqual(seen, ["circuit_open", "route_failed"], "订阅仅新告警");
unsub();

const sinceList = alerts.since(a1.id);
assert.strictEqual(sinceList.length, 1, "since 游标增量");
assert.strictEqual(sinceList[0].type, "route_failed");
assert.strictEqual(alerts.recent(10).length, 2);

// ── config_history: 备份列表 · 回滚 · 打包导出/导入 ──
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dao-config-history-"));
try {
  const configPath = path.join(root, "配置.json");
  const v1 = { providers: { p1: { baseUrl: "https://a" } }, daoRoutes: { routes: {} } };
  const v2 = { providers: { p2: { baseUrl: "https://b" } }, daoRoutes: { routes: {} } };
  fs.writeFileSync(configPath, JSON.stringify(v2, null, 2));
  const bakDir = path.join(root, ".config-backups");
  fs.mkdirSync(bakDir);
  const bakName = "配置.json.2026-01-01T00-00-00-000Z.bak";
  fs.writeFileSync(path.join(bakDir, bakName), JSON.stringify(v1, null, 2));

  const backups = history.listBackups(configPath);
  assert.strictEqual(backups.length, 1, "列出备份");
  assert.strictEqual(backups[0].name, bakName);

  // 非法备份名拒绝 (路径穿越防护)
  assert.strictEqual(history.rollback(configPath, "../配置.json.x.bak").ok, false);
  assert.strictEqual(history.rollback(configPath, "别的.json.x.bak").ok, false);

  const rb = history.rollback(configPath, bakName);
  assert.strictEqual(rb.ok, true, "回滚成功");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), v1, "配置已回滚到 v1");
  assert.ok(history.listBackups(configPath).length >= 2, "回滚前自动备份当前配置");

  // 导出配置包 → 改配置 → 导入还原
  const pack = history.exportPack(configPath);
  assert.strictEqual(pack.ok, true);
  assert.deepStrictEqual(pack.pack.config, v1, "打包内容一致");
  fs.writeFileSync(configPath, JSON.stringify(v2, null, 2));
  const imp = history.importPack(configPath, pack.pack);
  assert.strictEqual(imp.ok, true, "导入成功");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), v1, "导入还原 v1");

  // 空包/坏包拒绝
  assert.strictEqual(history.importPack(configPath, {}).ok, false);
  assert.strictEqual(history.importPack(configPath, "not json").ok, false);

  console.log("observability selftest: PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
