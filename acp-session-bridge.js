"use strict";

const http = require("node:http");
const https = require("node:https");
const http2 = require("node:http2");
const net = require("node:net");

// HTTP/2 连接前导序列(RFC 7540 §3.5) · 用于同口辨 h1/h2c
const HTTP2_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n", "utf8");

// 短路一条 gRPC/Connect 流时, 仍须回一个「完整的 gRPC 响应」: 只发 :status 200
// 而无 trailers, 客户端会一直等 grpc-status —— 实证即 Devin 取团队设置直等到
// "fetch timed out after 10000ms" → "Failed to activate agent"。
function respondWithoutForwarding(clientStream) {
  try {
    clientStream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    clientStream.on("wantTrailers", () => {
      try {
        clientStream.sendTrailers({
          "grpc-status": "8", // RESOURCE_EXHAUSTED · 冷却期不转发
          "grpc-message": "dao acp cooldown",
        });
      } catch (_) {}
    });
    clientStream.end();
  } catch (_) {
    try {
      if (!clientStream.closed) {
        clientStream.close(http2.constants.NGHTTP2_CANCEL);
      }
    } catch (_) {}
  }
}

function createAcpSessionBridge({ upstreamUrl, getSessionId, shouldBlock }) {
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`Unsupported ACP bridge upstream protocol: ${upstream.protocol}`);
  }
  if (typeof getSessionId !== "function") {
    throw new TypeError("getSessionId must be a function");
  }

  const upstreamClient = upstream.protocol === "https:" ? https : http;
  // URL 无显式端口时 upstream.port 为空串 · h1 转发须依协议取默认口
  const upstreamPort =
    upstream.port || (upstream.protocol === "https:" ? 443 : 80);
  let listeningPort = 0;

  function currentSessionId() {
    const sessionId = getSessionId();
    return typeof sessionId === "string" && sessionId ? sessionId : "";
  }

  // ── h2c 面 · ACP 推理主路 ──
  const h2Server = http2.createServer();
  h2Server.on("sessionError", () => {});
  h2Server.on("clientError", () => {});

  h2Server.on("stream", (clientStream, headers) => {
    const requestPath =
      typeof headers[":path"] === "string" && headers[":path"]
        ? headers[":path"]
        : "/";
    // 冷却闸门 · 由调用方按 RPC 路径判定。此面同时承推理与控制面(鉴权/座席/
    // 团队设置), 故闸门须精准: 一律拦则鉴权亦被吞, Devin 无从激活。
    if (typeof shouldBlock === "function" && shouldBlock(requestPath)) {
      respondWithoutForwarding(clientStream);
      return;
    }
    const target = http2.connect(upstream.origin);
    const forwardedHeaders = {
      ":method": headers[":method"] || "POST",
      ":path": headers[":path"] || "/",
      ":scheme": upstream.protocol.slice(0, -1),
      ":authority": upstream.host,
    };
    for (const [name, value] of Object.entries(headers)) {
      if (name.startsWith(":")) continue;
      if (name === "x-dao-acp-session") continue;
      forwardedHeaders[name] = value;
    }
    const sessionId = currentSessionId();
    if (sessionId) {
      forwardedHeaders["x-dao-acp-session"] = sessionId;
    }

    const upstreamStream = target.request(forwardedHeaders);
    let responded = false;
    const fail = () => {
      if (!responded && !clientStream.closed) {
        responded = true;
        try {
          clientStream.respond({ ":status": 502 });
        } catch (_) {}
      }
      if (!clientStream.closed) clientStream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      target.close();
    };

    target.on("error", fail);
    clientStream.on("error", () => {
      upstreamStream.close(http2.constants.NGHTTP2_CANCEL);
      target.close();
    });
    upstreamStream.on("error", fail);
    upstreamStream.on("response", (responseHeaders) => {
      if (responded || clientStream.closed) return;
      responded = true;
      clientStream.respond(responseHeaders);
    });
    upstreamStream.on("close", () => target.close());
    clientStream.pipe(upstreamStream);
    upstreamStream.pipe(clientStream);
  });

  // ── h1 面 · 鉴权/TeamSettings 等仍走 HTTP/1.1 ──
  const h1Server = http.createServer((req, res) => {
    const forwardedHeaders = { ...req.headers };
    delete forwardedHeaders["x-dao-acp-session"];
    forwardedHeaders.host = upstream.host;
    const sessionId = currentSessionId();
    if (sessionId) forwardedHeaders["x-dao-acp-session"] = sessionId;

    const upstreamRequest = upstreamClient.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: forwardedHeaders,
      },
      (upstreamResponse) => {
        res.writeHead(
          upstreamResponse.statusCode || 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(res);
      },
    );
    upstreamRequest.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("error", () => upstreamRequest.destroy());
    req.pipe(upstreamRequest);
  });
  h1Server.on("clientError", (_error, socket) => {
    if (socket && !socket.destroyed) socket.destroy();
  });

  // ── 同口多路 · 偷看首字节辨协议(与 source.js 同法) ──
  function serverForPreface(chunk) {
    const compareLength = Math.min(chunk.length, HTTP2_PREFACE.length);
    const matchesPrefix = chunk
      .subarray(0, compareLength)
      .equals(HTTP2_PREFACE.subarray(0, compareLength));
    if (!matchesPrefix) return h1Server;
    if (chunk.length >= HTTP2_PREFACE.length) return h2Server;
    return null; // 前导未足 · 待更多字节方可判
  }

  const mux = net.createServer((socket) => {
    socket.on("error", () => {});
    const route = () => {
      const chunk = socket.read();
      if (chunk === null) {
        socket.once("readable", route);
        return;
      }
      socket.unshift(chunk);
      const target = serverForPreface(chunk);
      if (!target) {
        socket.once("readable", route);
        return;
      }
      target.emit("connection", socket);
    };
    route();
  });

  return {
    async start() {
      if (listeningPort) return listeningPort;
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          mux.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          mux.off("error", onError);
          listeningPort = mux.address().port;
          resolve();
        };
        mux.once("error", onError);
        mux.once("listening", onListening);
        mux.listen(0, "127.0.0.1");
      });
      return listeningPort;
    },
    async close() {
      if (!listeningPort) return;
      await new Promise((resolve) => mux.close(resolve));
      for (const server of [h2Server, h1Server]) {
        try {
          server.close();
        } catch (_) {}
      }
      listeningPort = 0;
    },
  };
}

module.exports = { createAcpSessionBridge };
