"use strict";

// Dao Flow App 打开 Devin 会不会吃到提示缓存命中?
//
// 两条入口不是一回事:
//   默认「打开 Devin」= 原生窗口, 不包 ACP proxy, 缓存取决于 Devin 里已装的插件。
//   高级「托管 ACP」= spawn dao-acp-stdio-proxy + DAO_ACP_API_URL, 推理走本机 runtime。
// 本测试验证: 入口语义 + 当前 runtime 对 cccc 式 Anthropic 中继的两轮 cache_read。

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responseSink() {
  return {
    headersSent: false,
    writableEnded: false,
    chunks: [],
    writeHead(statusCode) {
      this.statusCode = statusCode;
      this.headersSent = true;
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

(async function main() {
  // ── 1. App 默认入口不包 ACP proxy, 不会自己把 Devin 推理拐进缓存 ──
  {
    const launch = fs.readFileSync(
      path.join(ROOT, "desktop/electron/services/devin-native-launch.ts"),
      "utf8",
    );
    assert.match(launch, /--new-window/);
    assert.match(launch, /--agents/);
    assert.doesNotMatch(launch, /dao-acp-stdio-proxy/);
    assert.doesNotMatch(launch, /DAO_ACP_API_URL/);
    assert.doesNotMatch(launch, /WINDSURF_API_SERVER_URL/);
  }

  // ── 2. 高级托管 ACP 才会把本机 runtime URL 注入 Devin 子进程 ──
  {
    const host = fs.readFileSync(
      path.join(ROOT, "desktop/electron/services/devin-acp-host.ts"),
      "utf8",
    );
    assert.match(host, /resources\.proxyPath, resources\.devinPath, 'acp'/);
    assert.match(host, /DAO_ACP_API_URL: runtime\.url/);
    const proxy = fs.readFileSync(path.join(ROOT, "dao-acp-stdio-proxy.js"), "utf8");
    assert.match(proxy, /DAO_ACP_API_URL/);
    assert.match(proxy, /WINDSURF_API_SERVER_URL/);
    assert.match(proxy, /createAcpSessionBridge/);
  }

  // ── 3. 当前 runtime: cccc 式 openai-compatible + anthropic 会带双鉴权 + 断点 ──
  const adapters = require(path.join(ROOT, "vendor/外接api/core/adapters.js"));
  const anthropic = adapters.adapterFor("anthropic");
  const relayHeaders = anthropic.buildRequestOpts(
    { type: "openai-compatible", apiKey: "relay-secret" },
    {},
    new URL("https://relay.invalid/v1/messages"),
  ).headers;
  assert.strictEqual(relayHeaders["x-api-key"], "relay-secret");
  assert.strictEqual(
    relayHeaders.Authorization,
    "Bearer relay-secret",
    "cccc-style Anthropic relays need Bearer affinity or cache_read stays 0",
  );

  const stableSystem = "You are a coding agent. " + "S".repeat(20_000);
  const body = anthropic.buildRequest({
    model: "claude-opus-5",
    system: stableSystem,
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "two" },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file from the workspace. " + "T".repeat(4_000),
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
    stream: true,
  });
  assert.ok(
    Array.isArray(body.system) && body.system[0] && body.system[0].cache_control,
    "system must carry cache_control",
  );
  assert.ok(
    body.tools[body.tools.length - 1].cache_control,
    "last tool must carry cache_control",
  );
  const lastMsg = body.messages[body.messages.length - 1];
  const lastBlocks = Array.isArray(lastMsg.content) ? lastMsg.content : [];
  assert.ok(
    lastBlocks.some((block) => block && block.cache_control),
    "last message must carry cache_control for incremental prefix",
  );
  const beta = anthropic.buildRequestOpts(
    { type: "openai-compatible", apiKey: "k" },
    body,
    new URL("https://relay.invalid/v1/messages"),
  ).headers["anthropic-beta"];
  assert.match(String(beta), /prompt-caching/);

  // ── 4. 两轮真 HTTP: 第一轮写缓存, 第二轮 usage.cached > 0 ──
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-devin-cache-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  const captured = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = JSON.parse(raw);
      captured.push({
        authorization: req.headers.authorization || "",
        apiKey: req.headers["x-api-key"] || "",
        beta: req.headers["anthropic-beta"] || "",
        body: parsed,
      });
      const isSecond = JSON.stringify(parsed).includes('"two"');
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse("message_start", {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 5_000,
              cache_read_input_tokens: isSecond ? 4_200 : 0,
              cache_creation_input_tokens: isSecond ? 0 : 4_200,
            },
          },
        }),
      );
      res.write(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
      res.write(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: isSecond ? "ok2" : "ok" },
        }),
      );
      res.write(
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        }),
      );
      res.end(sse("message_stop", { type: "message_stop" }));
    });
  });

  let router;
  try {
    await listen(server);
    const configPath = path.join(tempHome, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          cccc: {
            enabled: true,
            type: "openai-compatible",
            protocol: "anthropic",
            apiKey: "relay-secret",
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            completionPath: "/v1/messages",
            streamMode: "stream",
            models: ["claude-opus-5"],
            promptCache: { enabled: true },
          },
        },
        daoRoutes: {
          enabled: true,
          agentStatus: { enabled: false },
          routes: {
            MODEL_DEVIN_CACHE: { provider: "cccc", model: "claude-opus-5" },
          },
        },
      }),
    );
    router = require(path.join(ROOT, "vendor/外接api/core/dao_router.js"));
    router.init({ configPath, log: () => {} });

    const cascadeId = "devin-app-session";
    const first = await router.route(
      {},
      responseSink(),
      Buffer.from(
        JSON.stringify({
          modelUid: "MODEL_DEVIN_CACHE",
          prompt: stableSystem,
          messages: [{ role: "user", content: "one" }],
          tools: [
            {
              name: "read_file",
              description: "Read a file. " + "T".repeat(4_000),
              json_schema_string: JSON.stringify({
                type: "object",
                properties: { path: { type: "string" } },
              }),
            },
          ],
          cascadeId,
        }),
      ),
      true,
      "MODEL_DEVIN_CACHE",
    );
    assert.strictEqual(first, true, "first Devin-like turn must route");
    assert.strictEqual(captured.length, 1, "first turn reached mock Anthropic");
    assert.strictEqual(captured[0].authorization, "Bearer relay-secret");
    assert.strictEqual(captured[0].apiKey, "relay-secret");
    assert.match(String(captured[0].beta), /prompt-caching/);
    assert.ok(
      JSON.stringify(captured[0].body).includes("cache_control"),
      "first turn must send cache_control breakpoints",
    );
    const afterWrite = router.usage().cccc;
    assert.ok(afterWrite, "usage must include cccc after first turn");
    assert.ok(afterWrite.cacheWrite > 0, "first turn should record cache write");
    assert.strictEqual(afterWrite.cached, 0, "first turn is a miss/write, not a hit");

    const second = await router.route(
      {},
      responseSink(),
      Buffer.from(
        JSON.stringify({
          modelUid: "MODEL_DEVIN_CACHE",
          prompt: stableSystem,
          messages: [
            { role: "user", content: "one" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "two" },
          ],
          tools: [
            {
              name: "read_file",
              description: "Read a file. " + "T".repeat(4_000),
              json_schema_string: JSON.stringify({
                type: "object",
                properties: { path: { type: "string" } },
              }),
            },
          ],
          cascadeId,
        }),
      ),
      true,
      "MODEL_DEVIN_CACHE",
    );
    assert.strictEqual(second, true, "second Devin-like turn must route");
    assert.strictEqual(captured.length, 2, "second turn reached mock Anthropic");
    assert.strictEqual(captured[1].authorization, "Bearer relay-secret");
    assert.ok(
      JSON.stringify(captured[1].body).includes("cache_control"),
      "second turn must keep cache_control so the prefix can hit",
    );
    const afterHit = router.usage().cccc;
    assert.ok(
      afterHit.cached >= 4_200,
      "second turn must record cache_read, got cached=" + afterHit.cached,
    );
    const sample = (afterHit.requests || []).at(-1);
    assert.ok(sample && sample.cached >= 4_200, "latest sample must be a hit");
    assert.doesNotMatch(
      JSON.stringify(sample),
      /relay-secret|devin-app-session|You are a coding agent/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.env.HOME = prevHome;
    delete process.env.USERPROFILE;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  console.log("devin app cache hit selftest: PASS");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
