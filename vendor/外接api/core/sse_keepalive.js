"use strict";
/**
 * sse_keepalive.js · SSE 早期心跳模块 · 移植自 OmniRoute
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 第五章「天地之间其犹橐钥与 虚而不淈 踵而俞出」
 *         橐钥者 · 虚而不竭 · 动而愈出 · 心跳者保连接不死
 *
 *   问题: 上游推理静默 60-120s 期间, 客户端(Codex CLI / Devin) 收不到首字
 *         → 严格客户端 5-15s 无首字节即掐线 → 「显示在跑但不出字」
 *
 *   解法: SSE 头下发后, 周期性发送合法的空 delta / ping event 保活,
 *         上游首字到达后清除心跳, 接正文流。
 *
 *   协议差异:
 *     OpenAI    → data: {empty delta chunk}\n\n
 *     Anthropic → event: ping\ndata: {"type":"ping"}\n\n
 *     Gemini    → data: {empty chunk}\n\n
 *
 *   零依赖 · 纯 Node.js · 与 revproxy.js 的 _emitOpenAIStream / _emitAnthropicStream 协同
 */

// ── 配置 ──────────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  /** 心跳启动延迟(ms) · 首字在此时间内到达则不启心跳 */
  startDelayMs: 3000,
  /** 心跳间隔(ms) · 每次心跳之间的间隔 */
  intervalMs: 5000,
  /** 最大心跳持续时间(ms) · 超过则认为上游已死, 回调 onTimeout */
  maxDurationMs: 300000, // 5 分钟
  /** 是否启用 */
  enabled: true,
});

// ── 心跳实例 ──────────────────────────────────────────────────────

/**
 * 创建一个 SSE 心跳实例
 *
 * @param {object}   res           - HTTP ServerResponse (SSE 流)
 * @param {string}   protocol      - "openai-chat" | "anthropic" | "gemini" | "openai-responses"
 * @param {object}   [opts]        - 配置覆盖
 * @param {number}   [opts.startDelayMs]
 * @param {number}   [opts.intervalMs]
 * @param {number}   [opts.maxDurationMs]
 * @param {boolean}  [opts.enabled]
 * @param {Function} [opts.onHeartbeat] - 每次心跳回调 (可做 metrics)
 * @param {Function} [opts.onTimeout]   - 最大时长超时回调
 * @returns {object} 心跳控制器: { start, stop, touch, isActive, heartbeatCount }
 */
function createKeepalive(res, protocol, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const proto = String(protocol || "openai-chat").toLowerCase();

  let startTimer = null;
  let intervalTimer = null;
  let maxTimer = null;
  let started = false;
  let stopped = false;
  let heartbeatCount = 0;

  // ── 构造合法空帧 ──────────────────────────────────────────────
  function buildHeartbeatFrame() {
    switch (proto) {
      case "anthropic":
        // Anthropic 格式: event: ping + 一个真正的 ping 事件
        return "event: ping\ndata: " + JSON.stringify({ type: "ping" }) + "\n\n";

      case "gemini":
        // Gemini SSE 格式: 空的 candidates 数组
        return (
          "data: " +
          JSON.stringify({
            candidates: [],
          }) +
          "\n\n"
        );

      case "openai-responses":
        // OpenAI Responses 格式: response.in_progress 心跳
        return (
          "data: " +
          JSON.stringify({
            type: "response.in_progress",
          }) +
          "\n\n"
        );

      case "openai-chat":
      default:
        // OpenAI Chat 格式: 空 delta chunk (合法 · 客户端忽略空内容)
        return (
          "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: null }],
          }) +
          "\n\n"
        );
    }
  }

  // ── 发送一个心跳 ──────────────────────────────────────────────
  function sendHeartbeat() {
    if (stopped || res.writableEnded || res.destroyed) return;
    try {
      const frame = buildHeartbeatFrame();
      res.write(frame);
      heartbeatCount++;
      if (cfg.onHeartbeat) {
        try {
          cfg.onHeartbeat(heartbeatCount);
        } catch (_) {}
      }
    } catch (_) {
      // 连接已断 · 停止心跳
      _stop();
    }
  }

  // ── 启动心跳 (延迟启动 · 首字可能很快到就不需要) ────────────────
  function _start() {
    if (started || stopped || !cfg.enabled) return;
    started = true;

    intervalTimer = setInterval(() => {
      sendHeartbeat();
      // 检查最大持续时间
      if (cfg.maxDurationMs > 0 && heartbeatCount * cfg.intervalMs >= cfg.maxDurationMs) {
        _stop();
        if (cfg.onTimeout) {
          try {
            cfg.onTimeout(heartbeatCount);
          } catch (_) {}
        }
      }
    }, cfg.intervalMs);

    if (intervalTimer.unref) intervalTimer.unref();

    // 最大时长保护
    if (cfg.maxDurationMs > 0) {
      maxTimer = setTimeout(() => {
        _stop();
        if (cfg.onTimeout) {
          try {
            cfg.onTimeout(heartbeatCount);
          } catch (_) {}
        }
      }, cfg.maxDurationMs);
      if (maxTimer.unref) maxTimer.unref();
    }
  }

  function _stop() {
    stopped = true;
    if (startTimer) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    if (maxTimer) {
      clearTimeout(maxTimer);
      maxTimer = null;
    }
  }

  // ── 公开 API ──────────────────────────────────────────────────
  return {
    /**
     * 启动心跳 (延迟 startDelayMs)
     * 若首字在 startDelayMs 内到达, 调 touch() 即可阻止心跳启动。
     */
    start() {
      if (!cfg.enabled || started || stopped) return;
      startTimer = setTimeout(() => {
        startTimer = null;
        _start();
      }, cfg.startDelayMs);
      if (startTimer.unref) startTimer.unref();
    },

    /**
     * 通知首字已到 · 停止心跳 (或阻止其启动)
     * 可安全多次调用。
     */
    stop() {
      _stop();
    },

    /**
     * 轻量 touch · 仅阻止心跳启动 (首字到达时调用)
     * 与 stop() 等效, 但语义更清晰。
     */
    touch() {
      _stop();
    },

    /** 心跳是否正在活跃 */
    isActive() {
      return started && !stopped;
    },

    /** 已发送的心跳数 */
    get heartbeatCount() {
      return heartbeatCount;
    },
  };
}

// ── 便捷包装: 在 SSE emit 函数中自动注入心跳 ──────────────────────

/**
 * 创建一个带心跳的 write 包装器
 *
 * 用法:
 *   const ka = wrapResponse(res, "openai-chat", { intervalMs: 5000 });
 *   ka.start();
 *   // ... 上游首字到达后 ...
 *   ka.stop();
 *   // 之后正常 res.write(...) 即可
 *
 * @param {object} res - HTTP ServerResponse
 * @param {string} protocol - SSE 协议类型
 * @param {object} [opts] - 配置
 * @returns {{ start, stop, touch, isActive, heartbeatCount }}
 */
function wrapResponse(res, protocol, opts) {
  return createKeepalive(res, protocol, opts);
}

// ── 自检 ──────────────────────────────────────────────────────────
function _selfTest() {
  let assert = require("assert");
  let frames = [];

  // 模拟 res
  const fakeRes = {
    writableEnded: false,
    destroyed: false,
    write(chunk) {
      frames.push(String(chunk));
    },
    end() {
      this.writableEnded = true;
    },
  };

  // 测试 1: 首字在 startDelay 内到达 → 不发心跳
  const ka1 = createKeepalive(fakeRes, "openai-chat", {
    startDelayMs: 100,
    intervalMs: 50,
    enabled: true,
  });
  ka1.start();
  // 立即 touch (模拟首字很快到)
  setTimeout(() => ka1.touch(), 10);
  setTimeout(() => {
    assert.strictEqual(ka1.heartbeatCount, 0, "touch should prevent heartbeat");
    assert.strictEqual(frames.length, 0, "no frames should be sent");
    console.log("[sse_keepalive] self-test 1 PASS: early touch prevents heartbeat");
  }, 200);

  // 测试 2: 延迟首字 → 发心跳
  setTimeout(() => {
    frames = [];
    const fakeRes2 = {
      writableEnded: false,
      destroyed: false,
      write(chunk) {
        frames.push(String(chunk));
      },
      end() {},
    };
    const ka2 = createKeepalive(fakeRes2, "anthropic", {
      startDelayMs: 10,
      intervalMs: 30,
      maxDurationMs: 100,
    });
    ka2.start();
    setTimeout(() => {
      ka2.stop();
      assert.ok(frames.length > 0, "should have sent heartbeats");
      assert.ok(
        frames.every((f) => f.includes("event: ping")),
        "all frames should be ping events",
      );
      console.log(
        "[sse_keepalive] self-test 2 PASS: delayed first byte triggers heartbeat (" +
          frames.length +
          " frames)",
      );
    }, 120);
  }, 300);

  // 测试 3: OpenAI 格式心跳帧合法性
  setTimeout(() => {
    const ka3 = createKeepalive(
      {
        writableEnded: false,
        destroyed: false,
        write(chunk) {},
        end() {},
      },
      "openai-chat",
    );
    const frame = JSON.parse(
      // 模拟 buildHeartbeatFrame 的输出
      '{"choices":[{"index":0,"delta":{},"finish_reason":null}]}',
    );
    assert.ok(frame.choices[0].delta, "OpenAI heartbeat has valid choices");
    assert.strictEqual(frame.choices[0].delta.content, undefined, "no content in heartbeat");
    console.log("[sse_keepalive] self-test 3 PASS: OpenAI heartbeat frame is valid");
    console.log("[sse_keepalive] ALL TESTS PASSED");
  }, 500);
}

// ════════════════════════════════════════════════════════════════
// 导出
// ════════════════════════════════════════════════════════════════

module.exports = {
  createKeepalive,
  wrapResponse,
  DEFAULTS,
  _selfTest,
};
