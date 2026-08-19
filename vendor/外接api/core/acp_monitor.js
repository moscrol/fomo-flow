"use strict";
/**
 * acp_monitor.js · 把中间人的监测事件汇成「每轮一条 trace」
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 十六章「万物旁作 吾以观其复」· 观 ACP 每轮之复 · 汇于可观测栈
 *
 *   消费 acp_augment 的监测事件(prompt / agent_chunk / turn_complete),按请求 id
 *   关联出每轮 ACP 对话, 产出与 trace_center 同形的 trace 对象交给 onTrace 下沉
 *   (bin 侧接 OTEL 导出 → OTLP 后端)。纯函数式, 依赖注入 now/genId, 可测。
 *
 *   trace 形状(对齐 trace_center._serialize):
 *     { id, at, modelUid, status, durationMs, summary, steps:[{at,elapsedMs,type,...}] }
 */

function createAcpMonitor(opts = {}) {
  const onTrace = typeof opts.onTrace === "function" ? opts.onTrace : () => {};
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  let seq = 0;

  // 在途轮次: 按请求 id 关联; 另存 sessionId→id 以归集 agent_chunk。
  const turns = new Map(); // id -> turn
  const sessionToId = new Map(); // sessionId -> id
  const MAX_INFLIGHT = 256;

  function _key(id) {
    return id === undefined || id === null ? "" : String(id);
  }

  function _startTurn(event) {
    const id = _key(event.id);
    if (!id) return;
    const turn = {
      id,
      sessionId: event.sessionId || "",
      startedAt: now(),
      promptChars: Number(event.chars) || 0,
      promptBlocks: Number(event.blocks) || 0,
      redacted: event.redacted === true,
      findings: Array.isArray(event.findings) ? event.findings : [],
      agentChars: 0,
      agentChunks: 0,
    };
    turns.set(id, turn);
    if (turn.sessionId) sessionToId.set(turn.sessionId, id);
    // 防泄漏: 在途轮次上限, 超则丢最旧
    while (turns.size > MAX_INFLIGHT) {
      const oldest = turns.keys().next().value;
      if (oldest === undefined) break;
      turns.delete(oldest);
    }
  }

  function _accumChunk(event) {
    const id = _key(sessionToId.get(event.sessionId || ""));
    const turn = id && turns.get(id);
    if (!turn) return;
    turn.agentChars += Number(event.chars) || 0;
    turn.agentChunks += 1;
  }

  function _completeTurn(event) {
    const id = _key(event.id);
    const turn = turns.get(id);
    if (!turn) return;
    turns.delete(id);
    if (turn.sessionId && sessionToId.get(turn.sessionId) === id)
      sessionToId.delete(turn.sessionId);
    const endedAt = now();
    const durationMs = endedAt - turn.startedAt;
    const stopReason = String(event.stopReason || "end_turn");
    const status =
      stopReason === "cancelled" || stopReason === "refusal" ? "failed" : "ok";
    const steps = [
      {
        at: turn.startedAt,
        elapsedMs: 0,
        type: "prompt",
        sessionId: turn.sessionId,
        promptChars: turn.promptChars,
        promptBlocks: turn.promptBlocks,
        redacted: turn.redacted,
        findings: turn.findings.join(",") || "",
      },
      {
        at: endedAt,
        elapsedMs: durationMs,
        type: "turn_complete",
        stopReason,
        agentChars: turn.agentChars,
        agentChunks: turn.agentChunks,
      },
    ];
    onTrace({
      id: ++seq,
      at: turn.startedAt,
      modelUid: turn.sessionId ? `acp:${turn.sessionId}` : "acp",
      status,
      durationMs,
      summary: `acp turn stop=${stopReason} in=${turn.promptChars}c out=${turn.agentChars}c${turn.redacted ? " redacted" : ""}`,
      steps,
    });
  }

  function handleEvent(event) {
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "prompt":
        _startTurn(event);
        return;
      case "agent_chunk":
        _accumChunk(event);
        return;
      case "turn_complete":
        _completeTurn(event);
        return;
      default:
        return;
    }
  }

  return { handleEvent, inflight: () => turns.size };
}

module.exports = { createAcpMonitor };
