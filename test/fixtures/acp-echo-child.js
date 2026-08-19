"use strict";

const http2 = require("node:http2");

function emitBridgeProbe() {
  return new Promise((resolve) => {
    const apiUrl = process.env.WINDSURF_API_SERVER_URL || "";
    if (!apiUrl) return resolve();
    let client;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (client) client.close();
      resolve();
    };
    try {
      client = http2.connect(apiUrl);
      const stream = client.request({
        ":method": "POST",
        ":path": "/exabeam.api.v1.ChatService/GetChatMessage",
      });
      stream.on("error", finish);
      stream.on("response", () => stream.resume());
      stream.on("end", finish);
      client.on("error", finish);
      stream.end("bridge-probe");
    } catch (_) {
      finish();
    }
  });
}

// 冷却闸门实测 · 同一条桥上分探「推理」与「鉴权」两路。
// 短路一条 gRPC 流若不带 trailers, 客户端会一直等 grpc-status —— 实证即
// "fetch timed out after 10000ms" → "Failed to activate agent"。故此处同时取
// :status 与 trailers, 并自设 3s 上限, 令「悬挂」表现为 hung=true 而非卡死。
function probeBridgePath(requestPath) {
  return new Promise((resolve) => {
    const apiUrl = process.env.WINDSURF_API_SERVER_URL || "";
    const empty = {
      path: requestPath,
      status: 0,
      grpcStatus: "",
      body: "",
      hung: false,
    };
    if (!apiUrl) return resolve(empty);
    let client;
    let finished = false;
    let timer = null;
    let status = 0;
    let grpcStatus = "";
    const chunks = [];
    const finish = (hung) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try {
        if (client) client.close();
      } catch (_) {}
      resolve({
        path: requestPath,
        status,
        grpcStatus,
        body: Buffer.concat(chunks).toString("utf8"),
        hung: Boolean(hung),
      });
    };
    try {
      client = http2.connect(apiUrl);
      const stream = client.request({ ":method": "POST", ":path": requestPath });
      timer = setTimeout(() => finish(true), 3000);
      stream.on("response", (headers) => {
        status = Number(headers[":status"]) || 0;
      });
      stream.on("trailers", (trailers) => {
        grpcStatus = String(trailers["grpc-status"] || "");
      });
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", () => finish(false));
      stream.on("end", () => finish(false));
      client.on("error", () => finish(false));
      stream.end("probe");
    } catch (_) {
      finish(false);
    }
  });
}

const COOLDOWN_PROBE_PATHS = [
  "/exabeam.api.v1.ChatService/GetChatMessage",
  "/exabeam.api.v1.SeatManagementService/GetCliTeamSettings",
];

if (!process.env.ACP_ECHO_MODE) {
  process.stdin.pipe(process.stdout);
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", async () => {
    for (const line of input.split("\n")) {
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      if (process.env.ACP_ECHO_MODE === "cooldown-probe") {
        const probes = [];
        for (const requestPath of COOLDOWN_PROBE_PATHS) {
          probes.push(await probeBridgePath(requestPath));
        }
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { probes } }) +
            "\n",
        );
        continue;
      }
      const modelSwitch =
        (process.env.ACP_ECHO_MODE === "model-switch" ||
          process.env.ACP_ECHO_MODE === "model-session-isolation") &&
        request.method === "session/set_config_option";
      const nativeModelSwitch =
        process.env.ACP_ECHO_MODE === "native-model-switch" &&
        request.method === "session/set_model";
      // 真 Devin 的 session/new 响应同时含 sessionId 与 configOptions
      // (resultKeys: _meta/configOptions/modes) · session id 只在 result 里
      const sessionNewWithConfig =
        process.env.ACP_ECHO_MODE === "session-new-config" &&
        request.method === "session/new";
      const result =
        process.env.ACP_ECHO_MODE === "api-url"
          ? { apiUrl: process.env.WINDSURF_API_SERVER_URL || "" }
          : sessionNewWithConfig
          ? {
              sessionId: process.env.ACP_ECHO_SESSION_ID || "",
              configOptions: [
                {
                  id: "model",
                  category: "model",
                  name: "Model",
                  currentValue: "swe-1-6-slow",
                  type: "select",
                  options: [],
                },
              ],
            }
          : request.method === "session/new" && process.env.ACP_ECHO_SESSION_ID
          ? { sessionId: process.env.ACP_ECHO_SESSION_ID }
          : process.env.ACP_ECHO_MODE === "models"
          ? {
              models: {
                currentModelId: "dao-opus-5",
                availableModels: [
                  {
                    modelId: "dao-opus-5",
                    name: "Dao Opus 5",
                    description: "Dao test model",
                  },
                  {
                    modelId: "swe-1-6-slow",
                    name: "SWE Slow",
                  },
                ],
              },
            }
          : nativeModelSwitch
          ? {
              receivedModel: request.params.modelId,
              models: {
                currentModelId: request.params.modelId,
                availableModels: [
                  {
                    modelId: request.params.modelId,
                    name: "SWE Slow",
                  },
                ],
              },
            }
          : {
              ...(modelSwitch ? { receivedModel: request.params.value } : {}),
              configOptions: modelSwitch
                ? [
                    {
                      id: "model",
                      category: "model",
                      name: "Model",
                      currentValue: request.params.value,
                      type: "select",
                      options: [],
                    },
                  ]
                : [
                    {
                      id: "model",
                      category: "model",
                      name: "Model",
                      value: {
                        currentValue: "",
                        options:
                          process.env.ACP_ECHO_MODE === "invalid-config-options"
                            ? [{ name: "Malformed option" }]
                            : [],
                      },
                    },
                    {
                      id: "mode",
                      category: "agent",
                      name: "Mode",
                      value: { currentValue: "default", options: [] },
                    },
                  ],
            };
      if (
        process.env.ACP_ECHO_MODE === "bridge-probe" &&
        request.params &&
        typeof request.params.sessionId === "string"
      ) {
        await emitBridgeProbe();
      }
      if (nativeModelSwitch) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: request.params.sessionId,
              update: {
                sessionUpdate: "config_option_update",
                configOptions: [
                  {
                    id: "model",
                    category: "model",
                    name: "Model",
                    currentValue: request.params.modelId,
                    type: "select",
                    options: [],
                  },
                ],
              },
            },
          }) + "\n",
        );
      }
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
      );
    }
  });
}
