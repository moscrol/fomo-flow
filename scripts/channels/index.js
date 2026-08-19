#!/usr/bin/env node
"use strict";

/**
 * 本地通道适配器 · 统一通道接口 (Channel Contract)
 * ──────────────────────────────────────────────────────────────────────
 * 目的: 把「本地 AI 客户端网关」从 MiraSim 解耦, 使任意带本地 server 的
 *       客户端 (MiraSim / Kiro / Cursor / Codex ...) 都能作为同一网关的
 *       一个「通道」接入, 而不需要改动网关本身。
 *
 * 通道 = 一个实现以下接口的对象:
 *   {
 *     name: string,                       // 通道名, 如 "mirasim-cli"
 *     health(): Promise<object>,          // 返回 {ok, name, ...} 由网关透传给 /health
 *     complete(request, hooks): Promise<{
 *       text: string,                     // 最终文本
 *       toolCalls: Array<{id,name,arguments}> | [],  // 归一化 tool_calls (OpenAI 形态)
 *       usage: object,                    // {inputTokens, outputTokens, ...} 通道原始形态
 *     }>
 *   }
 *
 * request 字段 (网关归一后传入):
 *   { model, messages, tools, stream, agent }
 *   - messages: OpenAI 形态消息数组
 *   - tools:   归一化后的工具定义数组 (见 normalizeTools)
 *   - stream:  bool, 通道可用它决定内部行为; 流式输出统一走 hooks.onUpdate
 *   - agent:   可选, 通道自行决定是否使用
 *
 * hooks:
 *   { onUpdate({text}) }  — 文本增量回调, 网关用它拼 SSE delta
 *
 * 通道职责边界:
 *   - 入站: 接收 OpenAI 形态请求 (model/messages/tools)
 *   - 出站: 把请求翻译成上游客户端能理解的形式 (prompt 桥 / Anthropic Messages /
 *           本地 websocket 帧), 调用上游, 再把结果归一成 {text, toolCalls, usage}
 *   - 工具协议由通道自决: 可以塞进 prompt 让模型输出 JSON (CLI 桥), 也可以
 *     原生传递 (Anthropic tools)。网关不关心。
 *
 * 网关职责边界 (createGateway):
 *   - 鉴权 / CORS / /health / /v1/models
 *   - OpenAI 入站解析 (body → request)
 *   - OpenAI 出站翻译 (通道结果 → JSON / SSE)
 *
 * 已注册通道:
 *   "cli"           → mirasim-cli  (本地 MiraSim websocket)
 *   "direct-relay"  → mirasim-relay (Anthropic Messages → mirasim-relay.mirofish.ai)
 *   "kiro"          → kiro-acp     (官方 kiro-cli acp; 权限一律拒绝, 不 auto-allow)
 *
 * 网关 createGateway 经本工厂解析 transport, 新增通道在此注册即可。
 */

/**
 * 从 config.transport 工厂创建通道。
 */
function createChannel(options = {}) {
  const transport = String(options.transport || "cli").toLowerCase();
  if (transport === "cli") {
    const { createMirasimCliChannel } = require("./mirasim-cli.js");
    return createMirasimCliChannel(options);
  }
  if (transport === "direct-relay") {
    const { createMirasimRelayChannel } = require("./mirasim-relay.js");
    return createMirasimRelayChannel(options);
  }
  if (transport === "kiro") {
    const { createKiroChannel } = require("./kiro.js");
    return createKiroChannel(options);
  }
  throw new Error(`unknown channel transport: ${transport}`);
}

module.exports = { createChannel };
