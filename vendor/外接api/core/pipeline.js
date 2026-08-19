"use strict";
/**
 * pipeline.js · 可组合阶段管线 (P/ACP Conductor 骨架 · 里程碑步骤 1)
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 二十八章「朴散则为器」· 一条热路径散为可组合之器 · 各司其职
 *
 *   定位: dao-flow 是「介于 IDE 与 API 服务层之间的一张桌子」。桌上现有能力
 *   (改消息/稳定前缀/脱敏/缓存/agent-status/路由)此前揉在 route() 一条热路径里,
 *   难测、难开关、难调序。本模块提供最小 Conductor 骨架, 把这些能力逐步拆成
 *   有序、可独立启停/排序/测试的 Stage —— 并为后续对齐 Zed 的 P/ACP proxy-chains
 *   (作为标准 ACP proxy 接入任意宿主)打底。
 *
 *   Stage 契约 (纯函数式改写):
 *     { name, hard?, outbound?(ctx) -> result, inbound?(ctx) -> result }
 *   result:
 *     undefined            无变化 (跳过)
 *     { ctx }              用新 ctx 继续
 *     { block:{...} }      拦截: 停止后续 + 不上游 (由调用方决定如何拒绝)
 *     { shortCircuit:{..} } 短路: 停止后续 + 直接返回 (如缓存命中)
 *   ctx 由调用方定义, Conductor 不假设字段, 只负责编排、短路与轨迹。
 *
 *   方向: 出站(client→上游)正序穿过; 入站(上游→client)逆序穿过。
 */

function createConductor(stages) {
  const list = Array.isArray(stages)
    ? stages.filter((s) => s && typeof s === "object" && s.name)
    : [];

  function _run(dir, ctx) {
    const trace = [];
    let cur = ctx;
    const ordered = dir === "inbound" ? list.slice().reverse() : list;
    for (const stage of ordered) {
      const fn = stage[dir];
      if (typeof fn !== "function") continue;
      let out;
      try {
        out = fn(cur);
      } catch (e) {
        trace.push({ stage: stage.name, error: e && e.message ? e.message : String(e) });
        // hard 阶段异常向上抛; 否则记录并继续 (软失败不拖垮整条管线)
        if (stage.hard) throw e;
        continue;
      }
      if (!out) {
        trace.push({ stage: stage.name, applied: false });
        continue;
      }
      if (out.ctx !== undefined) cur = out.ctx;
      if (out.block) {
        trace.push({ stage: stage.name, blocked: true });
        return { ctx: cur, blocked: { stage: stage.name, ...out.block }, trace };
      }
      if (out.shortCircuit) {
        trace.push({ stage: stage.name, shortCircuit: true });
        return {
          ctx: cur,
          shortCircuit: { stage: stage.name, ...out.shortCircuit },
          trace,
        };
      }
      trace.push({ stage: stage.name, applied: true });
    }
    return { ctx: cur, trace };
  }

  return {
    stageNames: () => list.map((s) => s.name),
    runOutbound: (ctx) => _run("outbound", ctx),
    runInbound: (ctx) => _run("inbound", ctx),
  };
}

module.exports = { createConductor };
