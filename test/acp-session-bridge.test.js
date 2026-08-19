"use strict";

const assert = require("node:assert");
const http = require("node:http");
const http2 = require("node:http2");
const net = require("node:net");
const { once } = require("node:events");
const { createAcpSessionBridge } = require("../acp-session-bridge");

const HTTP2_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n", "utf8");

// 真反代(source.js)同口兼接 h1/h2c · 测试上游须同能, 否则桥之 h1 路无从检验。
// http2.createServer 之 allowHTTP1 仅 createSecureServer 有效 · 明文 h2c 不接 h1。
function createMuxUpstream(onRequest) {
  const h2Face = http2.createServer(onRequest);
  h2Face.on("sessionError", () => {});
  const h1Face = http.createServer(onRequest);
  const mux = net.createServer((socket) => {
    socket.on("error", () => {});
    const route = () => {
      const chunk = socket.read();
      if (chunk === null) {
        socket.once("readable", route);
        return;
      }
      socket.unshift(chunk);
      const compareLength = Math.min(chunk.length, HTTP2_PREFACE.length);
      const matchesPrefix = chunk
        .subarray(0, compareLength)
        .equals(HTTP2_PREFACE.subarray(0, compareLength));
      if (matchesPrefix && chunk.length < HTTP2_PREFACE.length) {
        socket.once("readable", route);
        return;
      }
      (matchesPrefix ? h2Face : h1Face).emit("connection", socket);
    };
    route();
  });
  return { mux, h2Face, h1Face };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

async function requestH1(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/exabeam.api.v1.SeatManagementService/GetCliTeamSettings",
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end("request");
  });
}

async function request(port) {
  const client = http2.connect(`http://127.0.0.1:${port}`);
  const stream = client.request({
    ":method": "POST",
    ":path": "/exabeam.api.v1.ChatService/GetChatMessage",
  });
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  stream.end("request");
  await once(stream, "end");
  client.close();
  return Buffer.concat(chunks).toString("utf8");
}

// 短路一条 gRPC 流时必须回完整响应(含 trailers) · 否则客户端等 grpc-status 到超时。
// 故此助手同时取 :status 与 trailers, 并自设 3s 上限以令「悬挂」表现为失败而非卡死。
async function requestH2Path(port, requestPath) {
  const client = http2.connect(`http://127.0.0.1:${port}`);
  const stream = client.request({ ":method": "POST", ":path": requestPath });
  const chunks = [];
  let status = 0;
  let trailers = {};
  stream.on("response", (headers) => {
    status = Number(headers[":status"]) || 0;
  });
  stream.on("trailers", (received) => {
    trailers = received;
  });
  stream.on("data", (chunk) => chunks.push(chunk));
  stream.end("request");
  const timer = setTimeout(() => stream.destroy(new Error("h2 stream hung")), 3000);
  try {
    await once(stream, "end");
  } finally {
    clearTimeout(timer);
    client.close();
  }
  return { status, trailers, body: Buffer.concat(chunks).toString("utf8") };
}

(async () => {
  const receivedSessions = [];
  // 上游同口兼接 h1/h2c · 与真反代(source.js 同口多路)同能
  const upstreamFaces = createMuxUpstream((req, res) => {
    receivedSessions.push(req.headers["x-dao-acp-session"] || "");
    res.end("ok");
  });
  const upstream = upstreamFaces.mux;
  const upstreamPort = await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
  let sessionA = "";
  let sessionB = "";
  const bridgeA = createAcpSessionBridge({
    upstreamUrl,
    getSessionId: () => sessionA,
  });
  const bridgeB = createAcpSessionBridge({
    upstreamUrl,
    getSessionId: () => sessionB,
  });
  try {
    const bridgeAPort = await bridgeA.start();
    const bridgeBPort = await bridgeB.start();
    sessionA = "session-a";
    sessionB = "session-b";

    assert.equal(await request(bridgeAPort), "ok");
    assert.equal(await request(bridgeBPort), "ok");
    assert.deepEqual(
      receivedSessions,
      ["session-a", "session-b"],
      "separate ACP bridge processes must inject only their own session identity",
    );

    // 鉴权/TeamSettings 仍走 HTTP/1.1 · 桥须与上游同能, 否则 devin local 连不上
    receivedSessions.length = 0;
    const h1 = await requestH1(bridgeAPort);
    assert.equal(
      h1.status,
      200,
      "the bridge must serve HTTP/1.1 as well as h2c, matching the upstream DAO API",
    );
    assert.equal(h1.body, "ok");
    assert.deepEqual(
      receivedSessions,
      ["session-a"],
      "HTTP/1.1 requests must carry the same injected session identity",
    );
  } finally {
    await bridgeA.close();
    await bridgeB.close();
    await close(upstream);
  }

  // ── 冷却闸门 · 只可拦推理, 不可拦鉴权 ──
  // 实证之病: 闸门一律拦下 h2c 全流 → devin.exe 取 GetCliTeamSettings 无应答 →
  // "fetch timed out after 10000ms" → "Failed to activate agent Devin Local"。
  const gatedPaths = [];
  const gatedUpstreamFaces = createMuxUpstream((req, res) => {
    gatedPaths.push(req.url || "");
    res.end("ok");
  });
  const gatedUpstream = gatedUpstreamFaces.mux;
  const gatedUpstreamPort = await listen(gatedUpstream);
  const gatedBridge = createAcpSessionBridge({
    upstreamUrl: `http://127.0.0.1:${gatedUpstreamPort}`,
    getSessionId: () => "",
    // 与 dao-acp-stdio-proxy 同法: 仅推理 RPC 落闸
    shouldBlock: (requestPath) => /\/(?:Raw)?GetChatMessage(?:V2)?$/.test(requestPath),
  });
  try {
    const gatedPort = await gatedBridge.start();

    const auth = await requestH2Path(
      gatedPort,
      "/exabeam.api.v1.SeatManagementService/GetCliTeamSettings",
    );
    assert.equal(
      auth.status,
      200,
      "the cooldown gate must never block authentication RPCs",
    );
    assert.equal(auth.body, "ok");
    assert.deepEqual(
      gatedPaths,
      ["/exabeam.api.v1.SeatManagementService/GetCliTeamSettings"],
      "authentication must still reach upstream while inference is gated",
    );

    gatedPaths.length = 0;
    const inference = await requestH2Path(
      gatedPort,
      "/exabeam.api.v1.ChatService/GetChatMessage",
    );
    assert.deepEqual(
      gatedPaths,
      [],
      "a gated inference RPC must not reach upstream",
    );
    assert.equal(
      inference.trailers["grpc-status"],
      "8",
      "a short-circuited gRPC stream must carry trailers, or the client waits for grpc-status until it times out",
    );
  } finally {
    await gatedBridge.close();
    await close(gatedUpstream);
  }

  console.log("acp session bridge selftest: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
