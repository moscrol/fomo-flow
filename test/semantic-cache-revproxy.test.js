"use strict";

// 集成: 验证 revproxy 侧语义缓存的 embed 文本构造 + embeddings HTTP 调用 +
//   两层 tee 写回 (exact + semantic 同时存)。

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-sem-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const revproxy = require("../vendor/外接api/core/revproxy.js");

(async () => {
  let server;
  try {
    // ── _semanticEmbedText: system + 消息文本拼接 ──
    const norm = {
      system: "you are helpful",
      messages: [
        { role: "user", content: "how do I cancel my subscription" },
        { role: "assistant", content: [{ type: "text", text: "click settings" }] },
      ],
    };
    const text = revproxy.__test.semanticEmbedText(norm);
    assert.ok(text.includes("you are helpful"), "system included");
    assert.ok(text.includes("cancel my subscription"), "user text included");
    assert.ok(text.includes("click settings"), "array-part text included");

    // maxChars 截断保留尾部
    const longNorm = { system: "", messages: [{ role: "user", content: "x".repeat(100) + "TAIL" }] };
    const clipped = revproxy.__test.semanticEmbedText(longNorm, 10);
    assert.strictEqual(clipped.length, 10, "clipped to maxChars");
    assert.ok(clipped.endsWith("TAIL"), "keeps tail on clip");

    // 有 system 时截断仍保留 system 头, 不把指令丢掉
    const sysNorm = {
      system: "SYSTEM_PROMPT_KEEP",
      messages: [{ role: "user", content: "y".repeat(80) + "TAIL" }],
    };
    const sysClipped = revproxy.__test.semanticEmbedText(sysNorm, 40);
    assert.ok(sysClipped.includes("SYSTEM_PROMPT"), "system head kept when clipping");
    assert.ok(sysClipped.length <= 40);

    // ── _embedText: 调用假 embeddings 端点 → 返回向量 ──
    let gotBody = null;
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        gotBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const vec = await revproxy.__test.embedText(
      "hello",
      { baseUrl: `http://127.0.0.1:${port}/v1`, model: "embed-test", apiKey: "k" },
      {},
    );
    assert.deepStrictEqual(vec, [0.1, 0.2, 0.3], "embed returns vector");
    assert.strictEqual(gotBody.model, "embed-test", "model sent to endpoint");
    assert.strictEqual(gotBody.input, "hello", "input text sent");

    // 端点未配置 → null (语义缓存降级)
    const none = await revproxy.__test.embedText("hi", { baseUrl: "", model: "" }, {});
    assert.strictEqual(none, null, "missing embed config → null");

    // ── 语义缓存 store/lookup 联动 ──
    const sc = revproxy.__test.getSemanticCache({
      semanticCache: { enabled: true, threshold: 0.9, ttlMs: 100000, maxEntries: 10 },
    });
    sc.clear();
    sc.store([0.1, 0.2, 0.3], { status: 200, body: Buffer.from("cached").toString("base64") });
    const hit = sc.lookup([0.1, 0.2, 0.3]);
    assert.ok(hit.hit, "semantic cache hit on same vector");
    assert.strictEqual(Buffer.from(hit.value.body, "base64").toString(), "cached");

    console.log("semantic cache revproxy integration: PASS");
  } finally {
    if (server) server.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
