#!/usr/bin/env node
"use strict";

/**
 * mirasim-relay 通道 · 直连 MiraSim Cloud relay (Anthropic Messages)
 * ──────────────────────────────────────────────────────────────────────
 * 复用 scripts/mirasim-direct-relay.js 的 createDirectRelay,
 * 把 OpenAI 形态请求翻译成 Anthropic Messages 直连 mirasim-relay.mirofish.ai。
 *
 * 注意: 这是「直连云端」通道, 不需要本地 MiraSim server 进程;
 *       但 relay 凭据来自 Keychain (mirasim-direct-relay) 或 MIRASIM_RELAY_TOKEN。
 *
 * 实现 Channel Contract (见 channels/index.js)。
 */

const path = require("node:path");
const { createDirectRelay } = require(path.join(__dirname, "..", "mirasim-direct-relay.js"));

function createMirasimRelayChannel(options = {}) {
  // 支持注入已创建的 relay 实例 (createGateway 传 options.relay 的场景),
  // 也支持只给 relayOptions 时内部自建 (config 驱动的场景)。
  const relay = options.relay || createDirectRelay(options.relayOptions || options);
  const model = String(options.model || relay.defaultModel || "claude-opus-5").trim();

  async function health() {
    const status = await relay.health();
    return { ok: status.ok === true, name: "mirasim-relay", baseURL: status.baseURL || null, model: status.model || model };
  }

  async function complete(request, hooks = {}) {
    const result = await relay.complete({
      ...request,
      onUpdate: typeof hooks.onUpdate === "function" ? (update) => {
        if (update && update.text) hooks.onUpdate({ text: String(update.text) });
      } : undefined,
    });
    const usage = result && result.usage && typeof result.usage === "object" ? result.usage : {};
    return {
      text: String((result && result.text) || ""),
      toolCalls: Array.isArray(result && result.toolCalls) ? result.toolCalls : [],
      usage: {
        inputTokens: Number(usage.inputTokens) || 0,
        outputTokens: Number(usage.outputTokens) || 0,
      },
    };
  }

  return { name: "mirasim-relay", model, health, complete };
}

module.exports = { createMirasimRelayChannel };
