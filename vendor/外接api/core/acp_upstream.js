"use strict";
/**
 * acp_upstream.js · ACP agent 的上游端点解析 (让 ACP 走 dao-flow 完整栈)
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 五十二章「既得其母 以知其子」· 母=本地反代 · 自寻其母则子皆通
 *
 *   ACP agent 的推理默认应流经 dao-flow 本地反代的 OpenAI 兼容端点 —— 那条路
 *   已含渠道路由 / 三层缓存 / 出站脱敏。故优先自动发现本地反代端点并读其 key,
 *   开箱即经完整栈, 无需手配; 显式 env(DAO_ACP_BASE_URL/API_KEY/MODEL)可覆盖。
 *
 *   解析优先级:
 *     baseUrl : DAO_ACP_BASE_URL(显式) > 自动发现的本地反代 <base>/v1 > 空(降级)
 *     apiKey  : DAO_ACP_API_KEY(显式) > revproxy.json 的 apiKey > 空
 *     model   : DAO_ACP_MODEL(显式) > "dao-flow"
 *
 *   全部依赖注入 (selectEndpoint/readKeyFile), 可确定性测试, 不碰真实 I/O。
 */

const path = require("node:path");
const os = require("node:os");
const { stateFile } = require("../../../core/product_identity.js");

function revproxyKeyPath() {
  return stateFile("revproxy.json") || "";
}

async function resolveUpstream(opts = {}) {
  const env = opts.env || {};
  const selectEndpoint =
    typeof opts.selectEndpoint === "function" ? opts.selectEndpoint : null;
  const readKeyFile =
    typeof opts.readKeyFile === "function" ? opts.readKeyFile : null;

  let baseUrl = "";
  const explicitBase = String(env.DAO_ACP_BASE_URL || "").trim();
  if (explicitBase) {
    baseUrl = explicitBase.replace(/\/+$/, "");
  } else if (selectEndpoint) {
    try {
      const base = await selectEndpoint();
      if (base) baseUrl = String(base).replace(/\/+$/, "") + "/v1";
    } catch (_) {
      baseUrl = "";
    }
  }

  let apiKey = String(env.DAO_ACP_API_KEY || "").trim();
  if (!apiKey && readKeyFile) {
    try {
      apiKey = String(readKeyFile() || "").trim();
    } catch (_) {
      apiKey = "";
    }
  }

  const model = String(env.DAO_ACP_MODEL || "").trim() || "fomo-flow";
  return { baseUrl, apiKey, model };
}

module.exports = { resolveUpstream, revproxyKeyPath };
