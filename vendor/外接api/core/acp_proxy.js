"use strict";
/**
 * acp_proxy.js · P/ACP 中间人代理引擎 (监测 · 运维 · 增益 · 不执行工具)
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 四章「和其光 同其尘」· 处编辑器与真 agent 之间 · 经手而不越位
 *
 *   定位: dao-flow 是「中间人」, 不是 IDE/agent。本引擎坐在编辑器(ACP client)
 *   与一个真正的 ACP agent(Claude Code / Gemini CLI / Codex 等)之间, 透明转发
 *   双向 ndJSON ACP 流, 只在需要处做:
 *     · 监测(monitor): 每条 prompt/response/update 计数与轨迹 (onEvent 回调)
 *     · 增益(augment): 出站 session/prompt 做脱敏/注入等改写
 *   工具调用 / 权限请求 / session/update 等一律【原样透传】—— 执行归真 agent,
 *   dao-flow 一根手指都不碰。
 *
 *   传输(ndJSON 行分帧)与转换(transform 依赖注入)分离, 可用内存流确定性测试。
 *   透传优化: transform 返回原对象引用(未改)时, 转发原始字节, 不重序列化。
 *
 *   transform(msg, ctx) 约定:
 *     返回 msg (可为原引用/新对象)        → 转发该消息
 *     返回 null / { drop:true }           → 丢弃不转发
 *     返回 { drop:true, reply:[m,...] }   → 丢弃不转发, 并把 reply 写回【来源方】
 *         (运维守卫: 中间人拦下超限 prompt, 直接向编辑器合成 ACP 响应, 不惊动下游 agent)
 *   ctx = { direction:"outbound"|"inbound", emit(event) }
 */

function createAcpProxy(opts = {}) {
  const editorIn = opts.editorIn;
  const editorOut = opts.editorOut;
  const agentIn = opts.agentIn;
  const agentOut = opts.agentOut;
  const transformOutbound =
    typeof opts.transformOutbound === "function" ? opts.transformOutbound : null;
  const transformInbound =
    typeof opts.transformInbound === "function" ? opts.transformInbound : null;
  const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : () => {};
  const onEnd = typeof opts.onEnd === "function" ? opts.onEnd : () => {};

  function _emit(event) {
    try {
      onEvent(event);
    } catch (_) {}
  }

  function _pump(src, writeLine, transform, direction, replyWrite) {
    let buf = "";
    const MAX_BUF = 8 * 1024 * 1024;
    src.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > MAX_BUF) {
        // 无换行洪水: 原样转发出去并清空, 避免中间人 OOM (不解析、不改写)
        _emit({ type: "line_overflow", direction, bytes: buf.length });
        writeLine(buf);
        buf = "";
        return;
      }
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const hasCR = raw.endsWith("\r");
        const line = hasCR ? raw.slice(0, -1) : raw;
        const eol = hasCR ? "\r\n" : "\n";
        if (!line.trim()) {
          writeLine(line + eol); // 空行原样透传
          continue;
        }
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_) {
          writeLine(line + eol); // 非 JSON 行: 原样透传, 不拦
          continue;
        }
        if (!transform) {
          writeLine(line + eol); // 无转换: 透传原字节
          continue;
        }
        let out;
        try {
          out = transform(msg, { direction, emit: _emit });
        } catch (e) {
          _emit({ type: "transform_error", direction, error: e && e.message ? e.message : String(e) });
          writeLine(line + eol); // 转换异常: 安全透传原消息, 不拖垮传输
          continue;
        }
        if (out === null || (out && out.drop === true)) {
          _emit({ type: "dropped", direction, method: msg.method });
          // 守卫回复: 把合成消息写回来源方(如向编辑器应答被拦下的 prompt)
          if (out && Array.isArray(out.reply) && typeof replyWrite === "function") {
            for (const rm of out.reply) {
              if (rm && typeof rm === "object") replyWrite(JSON.stringify(rm) + "\n");
            }
          }
          continue;
        }
        const finalMsg = out && out.message !== undefined ? out.message : out;
        if (finalMsg === msg) {
          writeLine(line + eol); // 未改: 转发原始字节 (透传保真)
        } else {
          writeLine(JSON.stringify(finalMsg) + eol);
        }
      }
    });
    src.on("end", () => onEnd(direction));
    if (typeof src.on === "function") src.on("error", () => {});
  }

  function start() {
    // 出站: 转发到 agent; reply 写回 editor(来源方)。入站: 转发到 editor; reply 写回 agent。
    _pump(editorIn, (s) => _safeWrite(agentIn, s), transformOutbound, "outbound", (s) => _safeWrite(editorOut, s));
    _pump(agentOut, (s) => _safeWrite(editorOut, s), transformInbound, "inbound", (s) => _safeWrite(agentIn, s));
    return { stop() {} };
  }

  return { start };
}

function _safeWrite(stream, s) {
  try {
    stream.write(s);
  } catch (_) {}
}

module.exports = { createAcpProxy };
