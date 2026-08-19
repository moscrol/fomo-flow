"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const failureStats = require("../vendor/外接api/core/failure_stats.js");
const audit = require("../vendor/外接api/core/action_audit.js");

// ── failure_stats: 分类 · 聚合 · 建议 ──
assert.strictEqual(failureStats.classify(401, ""), "auth");
assert.strictEqual(failureStats.classify(429, ""), "rate_limit");
assert.strictEqual(failureStats.classify(404, "model not found"), "model_missing");
assert.strictEqual(failureStats.classify(500, ""), "server");
assert.strictEqual(failureStats.classify(0, "TTFB stall"), "timeout");
assert.strictEqual(failureStats.classify(0, "ECONNREFUSED 127.0.0.1"), "network");

failureStats.clear();
failureStats.record("p1", "m1", { status: 429, error: "rate limit" });
failureStats.record("p1", "m1", { status: 429, error: "rate limit again" });
failureStats.record("p1", "m2", { status: 500, error: "boom" });
failureStats.record("p2", "m1", { status: 401, error: "bad key" });

const summary = failureStats.summary();
assert.strictEqual(summary.p1.total, 3);
assert.strictEqual(summary.p1.topKind, "rate_limit", "最多的错误类型置顶");
assert.ok(summary.p1.suggestion.includes("限流"), "给出建议");
assert.strictEqual(summary.p1.kinds.rate_limit.count, 2);
assert.strictEqual(summary.p1.kinds.rate_limit.samples.length, 2);
assert.strictEqual(summary.p2.topKind, "auth");

// ── action_audit: 记录 · 脱敏 · 落盘 · since ──
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dao-audit-"));
try {
  const auditPath = path.join(root, ".action-audit.jsonl");
  audit.clear();
  audit.init({ auditPath });
  const e1 = audit.record({
    action: "hotAddProvider",
    args: { name: "p1", cfg: { apiKey: "sk-abcdefghijklmn", baseUrl: "https://x" } },
    result: { ok: true },
  });
  audit.record({
    action: "hotRemoveProvider",
    args: { name: "p1" },
    result: { ok: false, error: "not found" },
  });
  const recent = audit.recent(10);
  assert.strictEqual(recent.length, 2);
  assert.strictEqual(recent[0].action, "hotRemoveProvider", "最新在前");
  assert.strictEqual(recent[0].ok, false);
  assert.strictEqual(recent[0].error, "not found");
  const key = recent[1].args.cfg.apiKey;
  assert.ok(!key.includes("abcdefghijklmn"), "apiKey 已脱敏");
  assert.ok(key.startsWith("sk-a") && key.endsWith("mn"), "留前4后2");

  const sinceList = audit.since(e1.id);
  assert.strictEqual(sinceList.length, 1);
  assert.strictEqual(sinceList[0].action, "hotRemoveProvider");

  // 落盘 JSONL (异步 append · 等一拍)
  setTimeout(() => {
    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    assert.strictEqual(lines.length, 2, "JSONL 落盘两条");
    assert.ok(!lines[0].includes("abcdefghijklmn"), "落盘内容亦脱敏");

    // ── dao_router 导出层: 危险动作经审计包装 ──
    const router = require("../vendor/外接api/core/dao_router.js");
    audit.clear();
    router.hotAddRoute("", null); // 参数非法 · 返回 error 但仍应入审计
    const wrapped = audit.recent(5);
    assert.strictEqual(wrapped.length, 1, "导出层动作入审计");
    assert.strictEqual(wrapped[0].action, "hotAddRoute");
    assert.strictEqual(wrapped[0].ok, false);
    assert.strictEqual(typeof router.getFailureStats(), "object");
    assert.ok(Array.isArray(router.getAuditLog()));

    // ── MCP server: initialize + tools/list 握手 ──
    const server = spawn(process.execPath, [
      path.join(__dirname, "..", "scripts", "dao-mcp-server.js"),
    ]);
    let buf = "";
    const done = new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("MCP server timeout")), 8000);
      server.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines2 = buf.split("\n").filter(Boolean);
        if (lines2.length >= 2) {
          clearTimeout(to);
          resolve(lines2.map((l) => JSON.parse(l)));
        }
      });
    });
    server.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
    );
    server.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
    );
    done
      .then((msgs) => {
        assert.strictEqual(
          msgs[0].result.serverInfo.name,
          require("../package.json").name,
        );
        const names = msgs[1].result.tools.map((t) => t.name);
        assert.ok(names.includes("dao_traces"), "有 dao_traces 工具");
        assert.ok(names.includes("dao_config_rollback"), "有 dao_config_rollback 工具");
        assert.strictEqual(names.length, 8, "8 个工具");
        server.kill();
        console.log("self-healing/audit/mcp selftest: PASS");
        fs.rmSync(root, { recursive: true, force: true });
      })
      .catch((e) => {
        server.kill();
        fs.rmSync(root, { recursive: true, force: true });
        console.error(e);
        process.exit(1);
      });
  }, 200);
} catch (e) {
  fs.rmSync(root, { recursive: true, force: true });
  throw e;
}
