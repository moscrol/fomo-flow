"use strict";
/**
 * acp_augment.js · ACP 中间人的增益+监测(可配置阶段链)
 * ═══════════════════════════════════════════════════════════════
 *
 *   为 acp_proxy 提供 transformOutbound/transformInbound, 内部由 pipeline.Conductor
 *   编排若干可开关、可排序的 stage:
 *     · redact  (增益): 出站 session/prompt 文本块脱敏(复用 outbound_redact)
 *     · inject  (增益): 出站 session/prompt 前缀注入
 *     · inject-detect (监测): 出站 prompt/resource 块注入话术检测(复用
 *                       inject_detect), monitor 只报 / block 命中即拒
 *     · monitor (监测): 双向计数 + 轻量轨迹(prompt 条数/字符、agent 输出字符、
 *                       每轮 stopReason), onMonitor 上报 + 内部 stats
 *
 *   顺序/启用由 opts.stages 决定(默认 ["inject","redact","monitor"]):
 *   先注入再脱敏, 避免 DAO_ACP_PROXY_INJECT 里的密钥漏扫。省略某 stage 即停用。
 *   绝不改写 agent 的工具调用/权限/输出语义 —— 中间人经手而不越位:
 *   入站只监测、不改。
 *
 *   透传保真: 未改动 msg 时返回原引用, acp_proxy 据此转发原始字节。
 */

const path = require("path");

let _outboundRedact = null;
try {
  _outboundRedact = require(path.join(__dirname, "outbound_redact"));
} catch (_) {
  _outboundRedact = null;
}
let _pipeline = null;
try {
  _pipeline = require(path.join(__dirname, "pipeline"));
} catch (_) {
  _pipeline = null;
}
let _injectDetect = null;
try {
  _injectDetect = require(path.join(__dirname, "inject_detect"));
} catch (_) {
  _injectDetect = null;
}

const DEFAULT_STAGE_ORDER = ["inject", "redact", "monitor"];

function createAugmentation(opts = {}) {
  const redactEnabled = opts.redact === true && !!_outboundRedact;
  const redactSettings = {
    mode: opts.redactMode || "redact",
    enableRules: opts.enableRules,
    disableRules: opts.disableRules,
    customRules: opts.customRules,
  };
  const injectPrefix =
    typeof opts.injectPrefix === "string" && opts.injectPrefix ? opts.injectPrefix : "";
  const onMonitor = typeof opts.onMonitor === "function" ? opts.onMonitor : () => {};
  // 运维守卫(可选): 出站 prompt 体积/频率限流 · 超限则合成 ACP 响应回编辑器, 不转发下游
  const guardCfg = opts.guard && typeof opts.guard === "object" ? opts.guard : null;
  const maxPromptChars = guardCfg && Number(guardCfg.maxPromptChars) > 0
    ? Math.floor(Number(guardCfg.maxPromptChars))
    : 0;
  const maxPromptsPerMin = guardCfg && Number(guardCfg.maxPromptsPerMin) > 0
    ? Math.floor(Number(guardCfg.maxPromptsPerMin))
    : 0;
  // 单块字符上限: 防单个 text/resource 块夹带超大载荷 (对应体积上限的块粒度版)
  const maxBlockChars = guardCfg && Number(guardCfg.maxBlockChars) > 0
    ? Math.floor(Number(guardCfg.maxBlockChars))
    : 0;
  // prompt 块数上限: 防结构层面的块洪泛
  const maxPromptBlocks = guardCfg && Number(guardCfg.maxPromptBlocks) > 0
    ? Math.floor(Number(guardCfg.maxPromptBlocks))
    : 0;
  const guardEnabled = !!(maxPromptChars || maxPromptsPerMin || maxBlockChars || maxPromptBlocks);
  // 注入监测(可选): 出站 prompt/resource 块扫注入话术 · monitor 只报 / block 命中即拒
  const injectDetectCfg =
    opts.injectDetect === true
      ? {}
      : opts.injectDetect && typeof opts.injectDetect === "object"
        ? opts.injectDetect
        : null;
  const injectDetectEnabled = !!injectDetectCfg && !!_injectDetect;
  const injectDetectSettings = injectDetectCfg
    ? {
        mode: injectDetectCfg.mode === "block" ? "block" : "monitor",
        enableRules: injectDetectCfg.enableRules,
        disableRules: injectDetectCfg.disableRules,
        customRules: injectDetectCfg.customRules,
      }
    : null;
  const _now = typeof opts.now === "function" ? opts.now : Date.now;
  const _rate = new Map(); // sessionId -> number[] (近一分钟 prompt 时间戳)
  let order = Array.isArray(opts.stages) && opts.stages.length
    ? opts.stages.slice()
    : DEFAULT_STAGE_ORDER.slice();
  // 配了注入监测但未在 stages 显式列出 → 排在链首附近, 扫原始 prompt(避开 inject 前缀)
  if (injectDetectEnabled && !order.includes("inject-detect")) {
    order = ["inject-detect", ...order];
  }
  // 配了守卫但未在 stages 显式列出 → 自动排到链首(尽早拦截)
  if (guardEnabled && !order.includes("guard")) {
    order = ["guard", ...order];
  }

  const stats = {
    prompts: 0,
    promptChars: 0,
    redactedPrompts: 0,
    redactFindings: 0,
    injectSuspectPrompts: 0,
    injectFindings: 0,
    agentChunks: 0,
    agentChars: 0,
    turns: 0,
  };

  function _monitor(event) {
    try {
      onMonitor(event);
    } catch (_) {}
  }

  const _isPrompt = (msg) => msg && msg.method === "session/prompt" && msg.params;

  // text 块 + resource.text 都计入体积; 同一块两者都有则相加(偏严, 防漏计)
  function _blockChars(b) {
    if (!b || typeof b !== "object") return 0;
    let n = 0;
    if (typeof b.text === "string") n += b.text.length;
    if (b.resource && typeof b.resource.text === "string") n += b.resource.text.length;
    return n;
  }
  function _promptChars(prompt) {
    return (Array.isArray(prompt) ? prompt : []).reduce((n, b) => n + _blockChars(b), 0);
  }

  function _scanPromptBlock(b) {
    if (!b || typeof b !== "object") return { block: b, changed: false, findings: [] };
    if (b.type === "text" && typeof b.text === "string" && b.text) {
      const r = _outboundRedact.scanText(b.text, redactSettings);
      return {
        block: r.changed ? { ...b, text: r.text } : b,
        changed: r.changed,
        findings: r.findings,
      };
    }
    if (
      b.type === "resource" &&
      b.resource &&
      typeof b.resource.text === "string" &&
      b.resource.text
    ) {
      const r = _outboundRedact.scanText(b.resource.text, redactSettings);
      return {
        block: r.changed
          ? { ...b, resource: { ...b.resource, text: r.text } }
          : b,
        changed: r.changed,
        findings: r.findings,
      };
    }
    return { block: b, changed: false, findings: [] };
  }

  function _promptRefusal(msg, reason, label) {
    const sid = (msg.params && msg.params.sessionId) || "";
    const reply = [];
    if (sid) {
      reply.push({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `[dao-flow ${label}] 已拦截: ${reason}` },
          },
        },
      });
    }
    if (msg.id !== undefined && msg.id !== null) {
      reply.push({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "refusal" } });
    }
    return { shortCircuit: { reply } };
  }

  // ── stage 工厂 ──────────────────────────────────────────────
  function _redactStage() {
    return {
      name: "redact",
      outbound(ctx) {
        if (!redactEnabled || !_isPrompt(ctx.msg)) return undefined;
        const prompt = Array.isArray(ctx.msg.params.prompt) ? ctx.msg.params.prompt : [];
        let changed = false;
        const findings = [];
        const next = prompt.map((b) => {
          const scanned = _scanPromptBlock(b);
          scanned.findings.forEach((f) => findings.push(f));
          if (scanned.changed) changed = true;
          return scanned.block;
        });
        ctx.meta.redactFindings = findings;
        if (redactSettings.mode === "block" && findings.length > 0) {
          const names = [...new Set(findings.map((f) => f.name))].join(",");
          const reason = `outbound redact blocked (${names || "secret"})`;
          _monitor({
            type: "redact_block",
            sessionId: (ctx.msg.params && ctx.msg.params.sessionId) || "",
            reason,
            findings: findings.map((f) => f.name),
          });
          if (ctx.emit) ctx.emit({ type: "redact_block", direction: "outbound", reason });
          return _promptRefusal(ctx.msg, reason, "出站脱敏");
        }
        if (!changed) return undefined; // 未改 → 保原引用
        return { ctx: { ...ctx, msg: { ...ctx.msg, params: { ...ctx.msg.params, prompt: next } } } };
      },
    };
  }

  function _injectStage() {
    return {
      name: "inject",
      outbound(ctx) {
        if (!injectPrefix || !_isPrompt(ctx.msg)) return undefined;
        const prompt = Array.isArray(ctx.msg.params.prompt) ? ctx.msg.params.prompt : [];
        const next = [{ type: "text", text: injectPrefix }, ...prompt];
        return { ctx: { ...ctx, msg: { ...ctx.msg, params: { ...ctx.msg.params, prompt: next } } } };
      },
    };
  }

  function _injectDetectStage() {
    return {
      name: "inject-detect",
      outbound(ctx) {
        if (!injectDetectEnabled || !_isPrompt(ctx.msg)) return undefined;
        const msg = ctx.msg;
        const sid = msg.params.sessionId || "";
        const prompt = Array.isArray(msg.params.prompt) ? msg.params.prompt : [];
        const r = _injectDetect.scanPromptBlocks(prompt, injectDetectSettings);
        if (r.findings.length === 0) return undefined; // 未命中 → 保原引用
        stats.injectSuspectPrompts++;
        stats.injectFindings += r.findings.reduce((n, f) => n + f.count, 0);
        const names = r.findings.map((f) => f.name);
        _monitor({
          type: "inject_detect",
          sessionId: sid,
          mode: injectDetectSettings.mode,
          blocked: r.blocked,
          findings: names,
        });
        if (ctx.emit)
          ctx.emit({ type: "inject_detect", direction: "outbound", blocked: r.blocked, findings: names });
        if (!r.blocked) return undefined; // monitor: 只报不改, 原样转发
        const reason = `prompt injection suspected (${names.join(",")})`;
        return _promptRefusal(msg, reason, "注入监测");
      },
    };
  }

  function _monitorStage() {
    return {
      name: "monitor",
      outbound(ctx) {
        const msg = ctx.msg;
        if (!_isPrompt(msg)) return undefined;
        const prompt = Array.isArray(msg.params.prompt) ? msg.params.prompt : [];
        const chars = _promptChars(prompt);
        const findings = Array.isArray(ctx.meta.redactFindings) ? ctx.meta.redactFindings : [];
        stats.prompts++;
        stats.promptChars += chars;
        if (findings.length > 0) {
          stats.redactedPrompts++;
          stats.redactFindings += findings.length;
        }
        _monitor({
          type: "prompt",
          id: msg.id !== undefined ? msg.id : null,
          sessionId: msg.params.sessionId || "",
          blocks: prompt.length,
          chars,
          redacted: findings.length > 0,
          findings: findings.map((f) => f.name),
        });
        if (ctx.emit)
          ctx.emit({ type: "prompt", direction: "outbound", chars, redacted: findings.length > 0 });
        return undefined; // 监测不改 msg
      },
      inbound(ctx) {
        const msg = ctx.msg;
        if (msg && msg.method === "session/update" && msg.params && msg.params.update) {
          const u = msg.params.update;
          if (u.sessionUpdate === "agent_message_chunk" && u.content && typeof u.content.text === "string") {
            stats.agentChunks++;
            stats.agentChars += u.content.text.length;
            _monitor({ type: "agent_chunk", sessionId: msg.params.sessionId || "", chars: u.content.text.length });
          }
        } else if (msg && msg.result && typeof msg.result.stopReason === "string") {
          stats.turns++;
          _monitor({ type: "turn_complete", id: msg.id !== undefined ? msg.id : null, stopReason: msg.result.stopReason });
          if (ctx.emit) ctx.emit({ type: "turn_complete", direction: "inbound", stopReason: msg.result.stopReason });
        }
        return undefined; // 入站一律不改
      },
    };
  }

  function _guardStage() {
    return {
      name: "guard",
      outbound(ctx) {
        const msg = ctx.msg;
        if (!_isPrompt(msg)) return undefined;
        const sid = msg.params.sessionId || "";
        const prompt = Array.isArray(msg.params.prompt) ? msg.params.prompt : [];
        const chars = _promptChars(prompt);
        let reason = "";
        if (maxPromptChars && chars > maxPromptChars) {
          reason = `prompt too large (${chars} > ${maxPromptChars} chars)`;
        } else if (maxPromptBlocks && prompt.length > maxPromptBlocks) {
          reason = `too many prompt blocks (${prompt.length} > ${maxPromptBlocks})`;
        } else if (maxBlockChars) {
          const oversized = prompt.find((b) => _blockChars(b) > maxBlockChars);
          if (oversized) {
            reason = `prompt block too large (${_blockChars(oversized)} > ${maxBlockChars} chars)`;
          }
        }
        if (!reason && maxPromptsPerMin) {
          const now = _now();
          const win = (_rate.get(sid) || []).filter((t) => now - t < 60000);
          if (win.length >= maxPromptsPerMin) {
            reason = `rate limit (${maxPromptsPerMin}/min) exceeded`;
          } else {
            win.push(now);
            _rate.set(sid, win);
          }
        }
        if (!reason) return undefined;
        _monitor({ type: "guard_block", sessionId: sid, chars, reason });
        if (ctx.emit) ctx.emit({ type: "guard_block", direction: "outbound", reason });
        return _promptRefusal(msg, reason, "运维守卫");
      },
    };
  }

  const _factories = {
    guard: _guardStage,
    redact: _redactStage,
    inject: _injectStage,
    "inject-detect": _injectDetectStage,
    monitor: _monitorStage,
  };
  const stages = order
    .map((name) => (_factories[name] ? _factories[name]() : null))
    .filter(Boolean);
  const conductor = _pipeline ? _pipeline.createConductor(stages) : null;

  function _runStages(dir, msg, proxyCtx) {
    if (!conductor) return msg; // pipeline 缺失 → 透传降级
    const emit = proxyCtx && typeof proxyCtx.emit === "function" ? proxyCtx.emit : () => {};
    const ctx = { msg, meta: {}, emit };
    const res = dir === "outbound" ? conductor.runOutbound(ctx) : conductor.runInbound(ctx);
    // 守卫短路: 丢弃不转发, 并把合成响应写回来源方
    if (res.shortCircuit) {
      return { drop: true, reply: Array.isArray(res.shortCircuit.reply) ? res.shortCircuit.reply : [] };
    }
    if (res.blocked) {
      // 阶段用 {block} 拦截时也必须回编辑器, 否则 session/prompt 会挂死
      if (_isPrompt(msg)) {
        const reason =
          (res.blocked && (res.blocked.reason || res.blocked.stage)) ||
          "blocked by stage";
        const sc = _promptRefusal(msg, String(reason), "拦截");
        return { drop: true, reply: sc.shortCircuit.reply };
      }
      return { drop: true };
    }
    return res.ctx && res.ctx.msg !== undefined ? res.ctx.msg : msg;
  }

  return {
    transformOutbound: (msg, ctx) => _runStages("outbound", msg, ctx),
    transformInbound: (msg, ctx) => _runStages("inbound", msg, ctx),
    stageNames: () => stages.map((s) => s.name),
    stats: () => ({ ...stats }),
  };
}

module.exports = { createAugmentation, DEFAULT_STAGE_ORDER };
