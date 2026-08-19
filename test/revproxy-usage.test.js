"use strict";

const assert = require("node:assert");
const EventEmitter = require("node:events");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-revproxy-usage-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const revproxy = require("../vendor/外接api/core/revproxy.js");

function mockRequest(body, headers = {}) {
  const request = new EventEmitter();
  request.method = "POST";
  request.url = "/v1/messages";
  request.headers = {
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  };
  request.socket = { remoteAddress: "127.0.0.1" };
  process.nextTick(() => {
    request.emit("data", Buffer.from(body));
    request.emit("end");
  });
  return request;
}

function mockResponse() {
  const response = new EventEmitter();
  response.statusCode = 0;
  response.headers = {};
  response.chunks = [];
  response.writableEnded = false;
  response.setHeader = (name, value) => {
    response.headers[String(name).toLowerCase()] = String(value);
  };
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers || {})) {
      response.headers[String(name).toLowerCase()] = String(value);
    }
  };
  response.write = (chunk) => {
    response.chunks.push(Buffer.from(chunk));
    return true;
  };
  response.end = (chunk) => {
    if (chunk) response.chunks.push(Buffer.from(chunk));
    response.writableEnded = true;
    response.emit("finish");
  };
  return response;
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function waitForResponse(response) {
  if (response.writableEnded) return Promise.resolve();
  return new Promise((resolve) => response.once("finish", resolve));
}

(async () => {
  let upstreamServer;
  try {
    upstreamServer = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sse("message_start", {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 3_000,
              cache_read_input_tokens: 2_400,
              cache_creation_input_tokens: 600,
            },
          },
        }));
        response.write(sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }));
        response.write(sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        }));
        response.write(sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        }));
        response.end(sse("message_stop", { type: "message_stop" }));
      });
    });
    await new Promise((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));

    fs.mkdirSync(path.join(tempHome, ".codeium", "dao-byok"), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, ".codeium", "dao-byok", "revproxy.json"),
      JSON.stringify({
        enabled: true,
        apiKey: "",
        providers: {},
        daoRoutes: {},
      }),
    );
    const config = {
      enabled: true,
      apiKey: "",
      providers: {
        mock: {
          enabled: true,
          protocol: "anthropic",
          type: "anthropic",
          baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
          completionPath: "/v1/messages",
          streamMode: "stream",
          models: ["claude-opus-5"],
        },
      },
      daoRoutes: {
        routes: {
          "mock/claude-opus-5": { provider: "mock", model: "claude-opus-5" },
        },
      },
    };
    fs.writeFileSync(
      path.join(tempHome, ".codeium", "dao-byok", "配置.json"),
      JSON.stringify(config),
    );

    const recorded = [];
    const localKey = revproxy.loadConfig().apiKey;
    const request = mockRequest(JSON.stringify({
      model: "mock/claude-opus-5",
      system: "stable prefix",
      messages: [{ role: "user", content: "return ok" }],
      stream: true,
    }), { "x-api-key": localKey });
    const response = mockResponse();
    const handled = await revproxy.handle(
      request,
      response,
      new URL("http://127.0.0.1/v1/messages"),
      {
        getEaConfig: () => config,
        recordUsage: (...args) => recorded.push(args),
        log: () => {},
      },
    );

    assert.strictEqual(handled, true);
    await waitForResponse(response);
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(recorded.length, 1);
    assert.deepStrictEqual(recorded[0][2], {
      input: 3_000,
      output: 1,
      cached: 2_400,
      cacheWrite: 600,
    });
    assert.match(Buffer.concat(response.chunks).toString("utf8"), /"text_delta"/);
    console.log("revproxy Anthropic usage selftest: PASS");
  } finally {
    if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
