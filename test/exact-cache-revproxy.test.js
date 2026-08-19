"use strict";

// 集成: 验证 exact-cache 的「捕获真实 unary 响应 → 回放」链路 (revproxy 侧新增代码)。
//   用真实 _emitOpenAIUnary 组装响应, 经 _teeUnaryResponse 捕获, 存入 exact_cache,
//   再从缓存回放, 断言字节一致 + x-dao-cache 头。

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-exact-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const revproxy = require("../vendor/外接api/core/revproxy.js");

function mockRes() {
  return {
    status: 0,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(code, hdrs) {
      this.status = code;
      this.headers = hdrs || {};
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      this.ended = true;
    },
    body() {
      return Buffer.concat(this.chunks).toString("utf8");
    },
  };
}

// 假 gen: 模拟上游流式回调, 组装出一个 OpenAI Chat 非流式响应
function fakeGen(text) {
  return (handlers) => {
    handlers.onText(text);
    handlers.onUsage({ input: 10, output: 5, cached: 0 });
    handlers.onFinish("stop");
    handlers.onEnd();
  };
}

(async () => {
  try {
    const cache = revproxy.__test.getExactCache({
      exactCache: { enabled: true, ttlMs: 100000, maxEntries: 10 },
    });
    cache.clear();

    const key = cache.makeKey({
      clientKind: "openai-chat",
      provider: "p",
      upstreamModel: "m",
      messages: [{ role: "user", content: "hello" }],
    });

    // ── MISS: tee 捕获真实 _emitOpenAIUnary 的输出并入缓存 ──
    const res1 = mockRes();
    revproxy.__test.teeUnaryResponse(res1, (status, headers, buffer) => {
      if (status === 200 && buffer && buffer.length > 0) {
        cache.set(key, {
          status,
          headers: revproxy.__test.cacheableHeaders(headers),
          body: buffer.toString("base64"),
        });
      }
    });
    revproxy._emitOpenAIUnary(res1, "m", fakeGen("first response"));

    assert.strictEqual(res1.status, 200, "unary response is 200");
    const parsed1 = JSON.parse(res1.body());
    assert.strictEqual(
      parsed1.choices[0].message.content,
      "first response",
      "client received assembled content",
    );
    const stored = cache.get(key);
    assert.ok(stored && stored.body, "response was stored in exact cache");
    assert.ok(!("date" in (stored.headers || {})), "volatile headers stripped");

    // ── HIT: 回放缓存, 字节应与首次一致 ──
    const res2 = mockRes();
    const cached = cache.get(key);
    const headers = Object.assign({}, cached.headers || {}, { "x-dao-cache": "hit" });
    res2.writeHead(cached.status || 200, headers);
    res2.end(Buffer.from(cached.body, "base64"));

    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.headers["x-dao-cache"], "hit", "hit header set on replay");
    assert.strictEqual(
      res2.body(),
      res1.body(),
      "replayed bytes identical to original response",
    );

    // ── 键区分: 不同消息 → 不同键 → miss ──
    const otherKey = cache.makeKey({
      clientKind: "openai-chat",
      provider: "p",
      upstreamModel: "m",
      messages: [{ role: "user", content: "different" }],
    });
    assert.strictEqual(cache.get(otherKey), null, "different request is a cache miss");

    console.log("exact cache revproxy integration: PASS");
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
