"use strict";
/**
 * agent_status.js · Dao Harness 通用状态栏（v2 核心）
 * ═══════════════════════════════════════════════════════════════
 *
 *  定位（七步）:
 *    1. 任务定义 → profile（coding / research / general）决定关注点
 *    2. 失控表   → 字段只服务「会改变下一步」的事实
 *    3. schema   → 内部 state 可丰富；渲染给 LLM 的必须短而可行动
 *    4. 谁维护   → 计数/exit/路径/todo 校验 = 代码；路径选择 = LLM
 *    5. 规则分硬软 → 硬规则留给路由/权限；软策略写入 status.strategy
 *    6. 闭环     → 每轮 prepareOutbound: observe → render → inject
 *    7. 渲染     → 真实读数 + 已计算结论 + 必要时的行动策略
 *
 *  公式: 状态栏 = 真实读数 + 已计算结论 + 软策略提示
 *  方案 A: 每轮替换旧 <agent_status> 快照（短任务优先）
 *
 *  边界: 禁止 LLM 回写 test_status / 计数；Harness 只信工具与系统事实。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { stateDir, legacyStateDir, resolveStateDir } = require("../../../core/product_identity.js");

const STATUS_MARKER = "<!--dao-agent-status-->";
const TAG = "agent_status";
// 持久化状态的 schema 版本。升到新值时，_load 会把旧状态里**可从消息轨迹重算**的
// 字段清空重算，只保留 mode/identity/route/environment 等不可推导项。
// 见 _load 里的迁移块：不做这一步，升级后状态栏会继续复述升级前的结论。
//
// ⚠ 何时必须 +1：判据是「同名字段的**语义/口径**有没有变」，不是「字段有没有增删」。
// 改了 goal 的提取逻辑、改了 failedTests 的过滤规则、改了任何「这个字段该长什么样」
// 的定义——都算变义，都必须升版本。否则存量数据按旧口径写入、按新口径解读，
// 而 _load 认为「已是最新版」不再迁移，脏值就永久驻留。
//
// 实测踩过：9.9.425 → 9.9.426 改了 failedTests 的噪音过滤但没升版本，
// 于是 9.9.425 期间写进去的 ["PASS  B-2: …"] 一直留着，状态栏持续建议
// 「focus on failing tests」去修一个早已通过的用例。
//
// 依据：serial-phase-budget-tail-reserve-and-carry-forward.md:20
//   「字段名相同不代表统计口径相同；跨 revision 聚合前必须先建立 semantic epoch」
// + ai-agent-book/book/chapter2.md:845
//   「把『新增一种问法』当成一次**数据库改表结构**来对待」
//
// 变更历史：
//   1  引入迁移（清空可重算字段，保留用户设置）
//   2  goal 改用白名单提取 + failedTests 噪音过滤 → 两个字段口径均变更
//   3  删除文本推断的 verification 段，改为模型显式声明的 testReport
//   4  goal 跳过 Devin 续写摘要整条消息（不是用户诉求）
const STATE_SCHEMA = 4;
const MAX_GOAL = 240;
const MAX_FAILED_TESTS = 4;
const MAX_TODOS = 10;
const MAX_STRATEGY = 5;
const MAX_ERROR_DETAIL = 180;
const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const DEFAULT_AUTO_TOOL_CALLS = 3;
const DEFAULT_AUTO_AFTER_MS = 90_000;

/** @type {Map<string, object>} */
const _mem = new Map();
const _listeners = new Set();
let _storeDir = null;
let _nowImpl = () => Date.now();

function _now() {
  return _nowImpl();
}

function _storeCandidates() {
  const dirs = [];
  const dest = stateDir();
  const src = legacyStateDir();
  if (dest) dirs.push(path.join(dest, "agent-status"));
  if (src) dirs.push(path.join(src, "agent-status"));
  return dirs;
}

function _ensureStoreDir() {
  if (_storeDir) return _storeDir;
  const preferred = resolveStateDir();
  const base = preferred
    ? path.join(preferred, "agent-status")
    : path.join(os.homedir(), ".fomo-flow", "agent-status");
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (_) {}
  _storeDir = base;
  return base;
}

function _safeKey(key) {
  return String(key || "anon")
    .replace(/[^a-zA-Z0-9._:-]/g, "_")
    .slice(0, 120);
}

function _filePath(key, options = {}) {
  const name = `${_safeKey(key)}.json`;
  if (!options.forWrite) {
    for (const dir of _storeCandidates()) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return path.join(_ensureStoreDir(), name);
}

function _cfgAgentStatus(cfg) {
  return (
    (cfg && cfg.daoRoutes && cfg.daoRoutes.agentStatus) ||
    (cfg && cfg.agentStatus) ||
    {}
  );
}

function isEnabled(cfg) {
  const as = _cfgAgentStatus(cfg);
  if (as === false) return false;
  if (as && as.enabled === false) return false;
  if (as == null || (typeof as === "object" && Object.keys(as).length === 0))
    return true;
  return as.enabled !== false;
}

function _normalizeMode(value, fallback = "auto") {
  const mode = String(value || "").toLowerCase();
  return mode === "auto" || mode === "on" || mode === "off" ? mode : fallback;
}

function _defaultMode(cfg) {
  const as = _cfgAgentStatus(cfg);
  return _normalizeMode(as.defaultMode, "auto");
}

function _autoReason(state, cfg) {
  const as = _cfgAgentStatus(cfg);
  const auto = (as && as.auto) || {};
  const byTool = (state.execution && state.execution.byTool) || {};
  const toolNames = Object.keys(byTool).join(" ").toLowerCase();
  if ((state.conclusions && state.conclusions.openTodos) > 0) return "todo";
  if (/edit|write|multi_edit|apply_patch/.test(toolNames)) return "edit";
  if (/pytest|jest|vitest|test/.test(toolNames)) return "test";
  if (/terminal|exec|run_command|bash|shell/.test(toolNames)) return "terminal";
  if (
    (state.execution && state.execution.lastError) ||
    (state.conclusions && state.conclusions.maxConsecutiveFailure) > 0
  ) return "failure";
  const minCalls = Math.max(
    1,
    Number(auto.minToolCalls) || DEFAULT_AUTO_TOOL_CALLS,
  );
  if ((state.execution.totalToolCalls || 0) >= minCalls) return "tools";
  const afterMs = Math.max(
    1_000,
    Number(auto.activateAfterMs) || DEFAULT_AUTO_AFTER_MS,
  );
  if (_now() - state.createdAt >= afterMs) return "duration";
  return "";
}

function _applyActivation(state, cfg) {
  state.mode = _normalizeMode(state.mode, _defaultMode(cfg));
  if (state.mode === "off") {
    state.activation = { state: "disabled", reason: "off", activatedAt: 0 };
    return state.activation;
  }
  if (state.mode === "on") {
    state.activation = {
      state: "active",
      reason: "manual",
      activatedAt:
        (state.activation && state.activation.activatedAt) || _now(),
    };
    return state.activation;
  }
  if (state.activation && state.activation.state === "active") {
    return state.activation;
  }
  const reason = _autoReason(state, cfg);
  state.activation = reason
    ? { state: "active", reason, activatedAt: _now() }
    : { state: "dormant", reason: "", activatedAt: 0 };
  return state.activation;
}

function _profileOf(cfg, state) {
  const as = _cfgAgentStatus(cfg);
  const p = String((as && as.profile) || (state && state.profile) || "auto")
    .toLowerCase()
    .trim();
  if (p === "coding" || p === "research" || p === "general") return p;
  // auto: 有 test/edit 痕迹 → coding；有 search/web → research；否则 general
  if (state) {
    const tools = (state.execution && state.execution.byTool) || {};
    const names = Object.keys(tools).join(" ").toLowerCase();
    if (
      /edit|write|multi_edit|run_tests|exec|pytest|jest/.test(names)
    )
      return "coding";
    if (/web_search|webfetch|browser|search|grep|code_search/.test(names))
      return "research";
  }
  return "general";
}

function _emptyState(key) {
  return {
    key: String(key || ""),
    _schema: STATE_SCHEMA,
    identity: { kind: "derived", id: String(key || "") },
    mode: "",
    activation: { state: "dormant", reason: "", activatedAt: 0 },
    activity: { requestInFlight: false, lastRequestAt: 0, lastUpdateAt: 0 },
    version: 0,
    profile: "general",
    createdAt: _now(),
    updatedAt: _now(),
    goal: "",
    phase: "start",
    todos: [],
    environment: {
      cwd: "",
      os: process.platform,
      gitBranch: "",
    },
    execution: {
      totalToolCalls: 0,
      byTool: {},
      consecutiveFailures: {},
      /** 同类调用（tool+args 指纹）连续失败 */
      sameCall: { fingerprint: "", tool: "", count: 0, lastArgsPreview: "" },
      lastTool: "",
      lastToolOk: null,
      lastError: null,
    },
    // ⚠ 这里曾经有一个 verification 段（latestTestStatus / failedTests /
    // testRuns / consecutiveTestFailures / testCommands）。已于 A 阶段删除。
    //
    // 删除原因：它的值靠**解析工具输出的自由文本**得来，而这是不可靠的取数方式。
    // 同一形状的误判撞了五次：
    //   判工具报错   搜 ENOENT/Traceback → 我读的源码里就有这些词
    //   判是否跑测试 搜路径含 test/       → `ls test/` 也算跑了测试
    //   判测试通过   搜 pass             → `bypass cache` 命中
    //   抓失败测试名 搜含 error 的行      → 抓到 Node 崩溃栈 `throw error;`
    //   判测试失败   搜 failed           → 命中变量名 `failedTests`
    // 最后一次现场：断言「verification 段应该消失」的测试用例名，被这个字段
    // 自己抓成了「失败的测试」，并生成策略命令我先去修好它们。
    //
    // 对照 ai-agent-book/chapter2/system-hint 参考实现：
    //   agent.py:199-205 状态栏只有 5 个字段（时间/目录/系统/Shell/Python 版本）
    //   agent.py:983     工具结果只挂 [时间戳] [Tool call #N] 两条元数据
    //   全文无 re.match / re.search / re.sub / re.findall
    //   判失败只看：except Exception / returncode == 0 / success is False
    //   grep latest_test|failed_test|verification|can_claim → 零命中
    //
    // 书并不反对记录测试状态——chapter2.md:855 恰好把「代码到底有没有通过测试」
    // 列为状态栏最有价值信息的第一例。但 :857 给了条件：信息必须来自
    // 「对外部世界的真实观测」，而非「可被污染的数据源」。stdout 里混着真实
    // 结果、源码、注释、探针打印，正是可被污染的那一类。
    //
    // B 阶段将用带外结构化信号重新接回：进程退出码、pytest --junitxml、
    // jest --json。拿不到这些信号时状态就是 unknown，且 unknown 不产生结论。
    /**
     * 测试结果：**只接受模型显式声明**，永不从文本推断。
     *
     * 缺省 undefined（而不是 {status:"unknown"} 空壳）——「没有声明」和
     * 「声明了但结果未知」是两件事，字段不存在最诚实。
     * 照抄 intelligence/eval/synthesis_health.py:16-17 的口径：
     * 「计入 unknown 而不是默认算好——『没测到』和『测到是好的』混为一谈，
     *   正是这次要修的那个毛病本身。」
     *
     * 形状（由 recordTestReport 写入）：
     *   { passed:N, failed:N, framework:"pytest", status:"passed"|"failed",
     *     at:<ms>, source:"declared" }
     */
    testReport: undefined,
    /** 已计算结论（代码推导，非 LLM 叙述） */
    conclusions: {
      canClaimComplete: false,
      openTodos: 0,
      maxConsecutiveFailure: 0,
      sameCallFailureStreak: 0,
    },
    /** 软策略：提醒，不硬拦（硬拦在路由/权限层） */
    strategy: [],
    route: {
      modelUid: "",
      provider: "",
      upstreamModel: "",
    },
    _msgWatermark: 0,
    _seenToolResultIds: {},
  };
}

/**
 * 一次性 schema 迁移：清掉可重算的旧读数，保留不可推导的设置。
 *
 * 9.9.424 实测事故：插件文件已完整替换、8955 也是新进程，状态栏却继续说旧话。
 * 根因是**持久化状态没有迁移**——_load 只「补缺字段」，observeMessages 又只在
 * `!state.goal` 时才重算 goal，于是升级前写进 JSON 的污染值永远不会被替换：
 *   - goal 停在 SessionStart 注入的「工作区事实 / 在途交接」段
 *   - testRuns / failedTests 停在历史 TDD 红阶段
 *   - todo 停在早已完成的那一条
 * 新代码在跑，旧结论却成了不可变事实——比不升级更坏，因为它看起来像已修好。
 *
 * 判据是「字段能否从当前消息轨迹重新推导」，而不是「字段是否存在」：
 *   能推导 → 清空，交给下一次 observeMessages 从完整消息重算
 *   不能推导（mode/identity/route/environment/activation/activity）→ 保留，
 *     否则会丢用户设置和路由归属
 *
 * 与 ~/agent-memory/10_knowledge/gate-covers-only-its-return-value.md 同源：
 * 只给新逻辑加闸门不够，**存量数据也要过一次闸门**，否则旧值绕过全部新判据。
 */
function _migrateState(previous, key) {
  const fresh = _emptyState(key);
  const preserved = {
    key: previous.key || key,
    identity: previous.identity,
    mode: previous.mode,
    activation: previous.activation,
    activity: previous.activity,
    environment: previous.environment,
    createdAt: previous.createdAt,
    version: previous.version,
    // 流水账：可从轨迹重算、且本身不产生结论，保留不会说假话。
    // 清掉它们反而会丢真实的会话累计量（消息被截断时无法重算）。
    _msgWatermark: previous._msgWatermark,
    _seenToolResultIds: previous._seenToolResultIds,
  };
  for (const [field, value] of Object.entries(preserved)) {
    if (value !== undefined && value !== null) fresh[field] = value;
  }
  if (previous.route && typeof previous.route === "object") {
    fresh.route = { ...previous.route };
    if (!Object.prototype.hasOwnProperty.call(fresh.route, "provisional")) {
      fresh.route.provisional = true;
    }
  } else {
    fresh.route = { ...fresh.route, provisional: true };
  }
  if (previous.execution && typeof previous.execution === "object") {
    fresh.execution = {
      ...fresh.execution,
      ...previous.execution,
      // 判断字段单独归零：它们直接驱动「你正在失败」这类结论，
      // 旧值一旦留下就是升级后仍在复述的假事实。
      lastToolOk: null,
      lastError: null,
    };
    if (
      !previous.execution.sameCall ||
      typeof previous.execution.sameCall !== "object"
    ) {
      fresh.execution.sameCall = { ..._emptyState(key).execution.sameCall };
    }
  }
  fresh._schema = STATE_SCHEMA;
  fresh.updatedAt = _now();
  return fresh;
}

function _load(key) {
  if (!key) return _emptyState("");
  const hit = _mem.get(key);
  // 内存命中也必须过 schema 迁移。原实现在这里直接 return，于是同进程内已缓存的
  // 旧状态永远绕过迁移——热重载（require.cache 清空但 _mem 常驻的场景）和
  // 同进程内升级都会漏。判据应当只有一处：状态的 _schema 是否落后。
  if (hit && _now() - hit.updatedAt < TTL_MS) {
    if (Number(hit._schema || 0) < STATE_SCHEMA) {
      const migrated = _migrateState(hit, key);
      _mem.set(key, migrated);
      return migrated;
    }
    return hit;
  }
  try {
    const raw = fs.readFileSync(_filePath(key), "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      obj.updatedAt = obj.updatedAt || _now();
      if (_now() - obj.updatedAt > TTL_MS) {
        _mem.delete(key);
        return _emptyState(key);
      }
      if (Number(obj._schema || 0) < STATE_SCHEMA) {
        const migrated = _migrateState(obj, key);
        _mem.set(key, migrated);
        return migrated;
      }

      // migrate older states
      const defaults = _emptyState(key);
      const hasOwn = (target, field) =>
        Object.prototype.hasOwnProperty.call(target, field);
      const fillMissing = (target, source) => {
        for (const [field, value] of Object.entries(source)) {
          if (!hasOwn(target, field)) target[field] = value;
        }
      };
      if (!obj.conclusions || typeof obj.conclusions !== "object") {
        obj.conclusions = defaults.conclusions;
      } else {
        fillMissing(obj.conclusions, defaults.conclusions);
      }
      if (!hasOwn(obj, "strategy")) obj.strategy = defaults.strategy;
      if (!hasOwn(obj, "todos")) obj.todos = defaults.todos;
      if (!obj.environment || typeof obj.environment !== "object") {
        obj.environment = defaults.environment;
      } else {
        fillMissing(obj.environment, defaults.environment);
      }
      // verification 段已删除（见 _emptyState 处的长注释）。旧状态里若残留，
      // 直接丢弃——它是靠解析自由文本推断出来的，没有任何值得保留的成分。
      delete obj.verification;
      if (!obj.route || typeof obj.route !== "object") {
        obj.route = { ...defaults.route, provisional: true };
      } else {
        fillMissing(obj.route, defaults.route);
        if (!hasOwn(obj.route, "provisional")) obj.route.provisional = true;
      }
      if (!obj.execution || typeof obj.execution !== "object") {
        obj.execution = defaults.execution;
      }
      if (!hasOwn(obj.execution, "sameCall")) {
        obj.execution.sameCall = defaults.execution.sameCall;
      }
      if (!hasOwn(obj, "_seenToolResultIds")) obj._seenToolResultIds = {};
      if (!obj.identity)
        obj.identity = { kind: "derived", id: String(key || "") };
      if (!hasOwn(obj, "mode")) obj.mode = "";
      if (!obj.activation)
        obj.activation = { state: "dormant", reason: "", activatedAt: 0 };
      if (!obj.activity)
        obj.activity = {
          requestInFlight: false,
          lastRequestAt: 0,
          lastUpdateAt: 0,
        };
      _mem.set(key, obj);
      return obj;
    }
  } catch (_) {}
  const st = _emptyState(key);
  _mem.set(key, st);
  return st;
}

function _save(state, options = {}) {
  if (!state || !state.key) return false;
  state.version = (state.version || 0) + 1;
  state.updatedAt = _now();
  _mem.set(state.key, state);
  if (_mem.size > MAX_SESSIONS) {
    const ordered = [..._mem.entries()].sort(
      (a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0),
    );
    while (_mem.size > MAX_SESSIONS) {
      const [k] = ordered.shift() || [];
      if (k) _mem.delete(k);
    }
  }
  const destination = _filePath(state.key);
  const temporary = `${destination}.${process.pid}.${crypto
    .randomBytes(4)
    .toString("hex")}.tmp`;
  let persisted = false;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, destination);
    persisted = true;
  } catch (_) {
    try {
      fs.unlinkSync(temporary);
    } catch (_) {}
  }
  if (persisted || options.emitOnFailure !== false) _emit(state);
  return persisted;
}

function _contentOf(msg) {
  if (!msg) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string") return p.text;
        if (p && typeof p.content === "string") return p.content;
        return "";
      })
      .join("\n");
  }
  if (c && typeof c === "object" && typeof c.text === "string") return c.text;
  return String(c || "");
}

function _isStatusPayload(text) {
  if (!text || typeof text !== "string") return false;
  if (text.includes(STATUS_MARKER)) return true;
  const t = text.trim();
  return t.startsWith(`<${TAG}`) && t.includes(`</${TAG}>`);
}

function stripStatusMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") {
      out.push(m);
      continue;
    }
    const text = _contentOf(m);
    if (
      (m.role === "user" || m._daoAgentStatus) &&
      _isStatusPayload(text)
    ) {
      continue;
    }
    if (typeof m.content === "string" && m.content.includes(`<${TAG}`)) {
      const cleaned = m.content
        .replace(
          new RegExp(
            `${STATUS_MARKER}\\s*<${TAG}[\\s\\S]*?</${TAG}>\\s*`,
            "g",
          ),
          "",
        )
        .replace(new RegExp(`<${TAG}[\\s\\S]*?</${TAG}>\\s*`, "g"), "")
        .trim();
      if (!cleaned && m.role === "user") continue;
      out.push({ ...m, content: cleaned || m.content });
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Harness 自动注入到 user 消息里的元信息块。
 *
 * 它们**不是用户说的话**，却物理上位于 user 消息中，且通常排在最前面。
 * 实测（2026-08-11 本会话）：goal 240 字符全被 `<system_info>` 占满，
 * 渲染出来是「目标：以下是关于你当前环境的自动生成信息…」——状态栏第一行
 * 就在说一件与任务无关的事，而这一行本该是「会改变下一步」的最强信号。
 *
 * 与 ai-agent-book ch2 状态栏原则的关系：状态栏是对上下文的**有损投影**，
 * 投影错了维度就成了「看着很像样、实则答非所问」的假权威。goal 尤其如此，
 * 它是模型判断「我在干什么」的锚点。
 */
const INJECTED_BLOCK_RE = new RegExp(
  "<(?:system_info|rules|additional_metadata|available_skills|note|" +
    "system_guidance|env|environment_details|ide_context|agent_status)" +
    "\\b[\\s\\S]*?<\\/(?:system_info|rules|additional_metadata|available_skills|" +
    "note|system_guidance|env|environment_details|ide_context|agent_status)>",
  "gi",
);

/**
 * 无 XML 标签的 Harness 注入段。
 *
 * 实测（9.9.424 升级后连续两个样本）：SessionStart hook 注入的
 *   `## 工作区事实（SessionStart 自动探测，非文档摘抄）`
 *   `# 在途交接 · fix/gate-rejection-taxonomy`
 * 都是**纯 Markdown**，没有 XML 包裹，INJECTED_BLOCK_RE 抓不到，goal 被占满。
 *
 * 第一版按标题名枚举（工作区事实 / Workspace Facts），第二个样本立刻漏了。
 * 枚举关键词是在追**样本**，而注入段的真正共性是**结构**：
 *   1. 以 Markdown 标题开头，且
 *   2. 标题所属段落里含「机器生成的元信息」标记——`更新：<日期> · <agent>`、
 *      `@ <分支/commit>`、`解释器:`、`git status` 式清单等。
 * 光有标题不够（用户完全可能用标题写需求），必须叠加机器标记才判为注入。
 *
 * 判据落在结构而非词表，是 evidence-hygiene 形状二的同一课：
 * 手维护的清单一定会漏，可推导的特征才稳定。
 */
const INJECTED_MD_SIGNALS = [
  /（\s*SessionStart[^）]*）/i,
  /\bSessionStart\b/,
  /^\s*更新[:：]\s*\d{4}-\d{2}-\d{2}/m,
  /^\s*解释器[:：]/m,
  /^\s*树[:：].*@/m,
  /^\s*在途交接\b/m,
];

// 注入段的终止边界。三者取最近：
//   1. 下一个 Markdown 标题
//   2. 空行 + 紧跟「普通句子」（无缩进、不以 Markdown/装饰符号开头）
//   3. 文本结束
//
// 第 2 条是必需的：实测注入段后面直接跟用户真实诉求，中间只隔一个空行、
// 没有新标题。少了它，正则会一路吃到文本尾，把用户的话也删掉——那是
// **清洗过度**，比漏清更危险（goal 变空，状态栏第一行直接失去锚点）。
//
// 反过来，注入段自身内部的空行后面通常是缩进行或 `##`/`-`/`⚠` 之类的
// 装饰行，所以用「无缩进 + 非符号开头」来区分「用户开始说话了」。
// 已知边界：注入段内部若出现「空行 + 无缩进普通句子」会提前收尾、留下尾巴；
// 用循环到不动点缓解，但不保证全清。
const INJECTED_MD_SECTION_RE = new RegExp(
  "(?:^|\\n)[ \\t]*(#{1,6})[ \\t]*([^\\n]*)\\n" +
    "([\\s\\S]*?)" +
    "(?=\\n[ \\t]*#{1,6}[ \\t]|\\n[ \\t]*\\n[^\\s#\\-*>|]|$)",
  "g",
);

function _stripInjectedMarkdown(text) {
  let t = String(text || "");
  let out = "";
  let cursor = 0;
  INJECTED_MD_SECTION_RE.lastIndex = 0;
  let m;
  // 注入产物是**连续**的多个标题节：`# 在途交接` 后面紧跟 `## 这个分支做什么`、
  // `## 当前状态`……只有第一节带机器标记（`更新：<日期> · <agent>`），
  // 后续小节看上去和普通标题无异。只判单节会留下一串尾巴，而那串尾巴
  // 恰好会占满 goal（实测：goal 变成「## 这个分支做什么 加 RejectionKind…」）。
  //
  // 所以判据要沿**紧邻关系**传播：与已判定注入段直接相接的下一节，同样算注入。
  // 一旦中间出现普通正文（cursor 与下一节 index 不相接），传播即中断——
  // 这道中断是防清洗过度的闸门，用户真实诉求不会被连带删掉。
  // carryLevel = 已判定注入段的标题层级；-1 表示当前不在注入段里。
  // 传播条件是「更深层级的子节」，不是「位置相接」。
  //
  // 只看相接会清洗过度：实测样本 `## 工作区事实…` 之后紧跟用户自己写的
  // `## 我的需求`，两者同级且相接，goal 被清成空字符串——状态栏第一行
  // 直接失去锚点，比留着脏 goal 更糟。
  // 注入段的子节一定比它的段首**更深**（`# 在途交接` → `## 这个分支做什么`），
  // 而用户另起的话题是同级或更浅，层级差正好把两者分开。
  let carryLevel = -1;
  while ((m = INJECTED_MD_SECTION_RE.exec(t)) !== null) {
    const section = m[0];
    const level = (m[1] || "#").length;
    const heading = m[2] || "";
    const body = m[3] || "";
    const probe = `${heading}\n${body}`;
    const selfMarked = INJECTED_MD_SIGNALS.some((re) => re.test(probe));
    const inheritsInjection = carryLevel >= 0 && level > carryLevel;
    if (selfMarked || inheritsInjection) {
      out += t.slice(cursor, m.index) + " ";
      cursor = m.index + section.length;
      // 段首自带标记时以它为锚；子节继承时保持原锚，避免锚点越走越深
      if (selfMarked) carryLevel = level;
    } else {
      carryLevel = -1;
    }
  }
  out += t.slice(cursor);
  return out;
}

const INJECTED_TAG_NAMES =
  "system_info|rules|additional_metadata|available_skills|note|" +
  "system_guidance|env|environment_details|ide_context|agent_status";

const ORPHAN_CLOSING_RE = new RegExp(`</(?:${INJECTED_TAG_NAMES})>`, "i");

/**
 * 孤立的**闭合**标签。
 *
 * 开标签在上一条消息里，或整块被 harness 截断，本条只剩尾部
 * `</available_skills>`。配对正则匹配不上——9.9.425 实测状态栏的 goal
 * 恰好等于字符串 "</available_skills>"。
 *
 * 第一版做法是「吃掉闭标签左侧全部内容」，错得很直接：左侧不一定是注入
 * 残体。实测样本 A-2 的形状是
 *     验收，并总结你做了什么优化
 *     - **video-use**: xxx
 *     </available_skills>
 * 用户的话在**最前面**，注入残体夹在中间。整片吃掉就把诉求删了。
 *
 * 所以改成逐行处理：只丢弃闭标签所在行，以及它上方**连续的**元信息行
 * （列表项、`键: 值`、缩进行……）。一旦遇到看起来像人话的行就停手。
 * 这条「向上回溯到非元信息行为止」的边界，就是防清洗过度的闸门。
 */
function _stripOrphanClosingTag(text) {
  const t = String(text || "");
  if (!ORPHAN_CLOSING_RE.test(t)) return t;
  const lines = t.split("\n");
  const drop = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!ORPHAN_CLOSING_RE.test(lines[i])) continue;
    drop.add(i);
    // 向上回溯：连续的元信息行属于被切断的注入块，一并丢弃
    for (let j = i - 1; j >= 0; j--) {
      const line = lines[j].trim();
      if (!line) {
        drop.add(j);
        continue;
      }
      if (!_looksLikeMetaLine(line)) break;
      drop.add(j);
    }
  }
  return lines
    .filter((_, i) => !drop.has(i))
    .join("\n")
    .trim();
}

/**
 * 「这一行像机器生成的元信息，而不是人在说话」。
 *
 * 判据是**行首形状**，不是关键词表：Markdown 标题/列表/引用/表格、
 * `键: 值` 清单、绝对路径、状态装饰符、XML 标签、纯符号分隔线。
 * 词表会随样本增长而永远漏，形状不会。
 */
function _looksLikeMetaLine(line) {
  const s = String(line || "").trim();
  if (!s) return true;
  if (/^[#>\-*|`+=~_]/.test(s)) return true;
  if (/^[⚠✅🔴🟢📒🚫🔁🧠📚👤⭐]/u.test(s)) return true;
  if (/^<\/?[a-z_][\w-]*>?/i.test(s)) return true;
  if (/^\//.test(s)) return true;
  if (/^\(/.test(s)) return true;
  if (/^[\w\u4e00-\u9fa5 ]{1,12}[:：]\s*\S/.test(s)) return true;
  return false;
}

function _stripInjectedBlocks(text) {
  let t = String(text || "");
  let prev;
  // 循环到不动点：块可嵌套/相邻，一遍 replace 可能留下残壳
  do {
    prev = t;
    t = t.replace(INJECTED_BLOCK_RE, " ");
  } while (t !== prev);
  // 未闭合的注入块（被截断的场景）：从开标签吃到文本尾
  t = t.replace(
    /<(?:system_info|rules|additional_metadata|available_skills|system_guidance)\b[\s\S]*$/i,
    " ",
  );
  t = _stripOrphanClosingTag(t);
  // 无标签的注入段（SessionStart 的「工作区事实」/「在途交接」等）
  do {
    prev = t;
    t = _stripInjectedMarkdown(t);
  } while (t !== prev);
  return t.trim();
}

/**
 * 从 Harness 注入的 system_info 块里取真实 cwd。
 *
 * 为什么值得单独做：cwd 恰好就写在污染 goal 的那段文本里
 * （`Current workspace directories:` / `(cwd)` 标注）。原实现只认
 * workspaceRoots 入参，ACP/多根工作区下拿不到，于是 cwd="" 常驻，
 * 触发「Working directory is unknown」——而同一份状态栏里记着上百次
 * 成功的 exec，cwd 显然可用。**永远发红的提示会训练人忽略它**
 * （~/agent-memory/10_knowledge/evidence-hygiene-three-failure-shapes.md 形状三）。
 */
function _cwdFromInjectedInfo(messages) {
  for (const m of messages || []) {
    if (!m || m.role !== "user") continue;
    const raw = _contentOf(m);
    if (!raw || raw.indexOf("<system_info") === -1) continue;
    const block = raw.slice(raw.indexOf("<system_info"));
    // 优先「显式标了 (cwd) 的那一行」，其次工作区列表第一条
    const marked = block.match(/^\s*(\/[^\s]*?)\s*\(cwd\)/m);
    if (marked && marked[1]) return marked[1];
    const list = block.match(
      /(?:Current\s+)?workspace directories?:?\s*([\s\S]{0,400}?)(?:\n\s*\n|Platform:|OS Version:|<\/system_info>)/i,
    );
    if (list && list[1]) {
      const first = list[1]
        .split("\n")
        .map((s) => s.trim().replace(/\s*\(cwd\)\s*$/, ""))
        .find((s) => s.startsWith("/"));
      if (first) return first;
    }
  }
  return "";
}

/**
 * 清洗过度时的 goal 兜底：取最后一行看起来像人话的内容。
 *
 * 注入段总在消息前部（SessionStart hook 先注入、用户的话追加在后），所以
 * 从尾部往前找第一条「不像元信息」的行，命中率高且代价有界。
 *
 * 排除的行型都是机器生成的形状特征，不是关键词表：
 *   Markdown 标题 / 列表 / 引用 / 表格、`键: 值` 式清单、路径、
 *   `⚠ ✅ 🔴` 等状态装饰符、纯符号分隔线。
 */
function _tailUserLine(text) {
  const lines = String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.length < 2) continue;
    // 与 _stripOrphanClosingTag 共用同一套「像元信息」判据。
    // 早期这里自带一份重复的行型清单，漏了 XML 标签一项，于是清洗把整条
    // 消息判成元信息后，兜底又把 "</available_skills>" 当人话捡回来当 goal。
    // 两处判据必须同源，否则一处收紧、另一处就成了绕过它的后门。
    if (_looksLikeMetaLine(line)) continue;
    return line;
  }
  return "";
}

/**
 * Devin Local 续写会话的 harness 信封——整条 user 消息都不是用户诉求。
 *
 * ⚠ 同一前缀判据在仓库里有三份拷贝，改文案必须三处同步：
 *   1. 这里（模型侧状态栏，唯一进 prompt 的一份）
 *   2. desktop/electron/services/dao-observation-source.ts · safeSessionGoal
 *   3. desktop/src/components/collaboration/collaborationModel.ts
 *   (2)(3) 只是给人看的 HUD 投影；(1) 才是模型看见的。两个消费者一份名单，
 *   之前就是只在 HUD 侧滤、模型侧没滤，脏 goal 钉死一路注入。
 */
function _isContinuationHarnessMessage(text) {
  const head = String(text || "").trim();
  if (!head) return false;
  return (
    /^You are continuing work from a previous conversation thread\b/i.test(
      head,
    ) ||
    /^Below is a summary of the previous conversation thread\b/i.test(head)
  );
}

/**
 * 「这一行有资格当作用户说的话」——白名单判据。
 *
 * 为什么从黑名单翻过来：我已经补了四轮剥离规则（XML 标签块 → 纯 Markdown 段
 * → 孤立闭合标签 → 方括号截断行），每轮都是在追下一个样本。
 * ai-agent-book/book/chapter2.md:679-681 把这件事定性了：
 *   「输入清洗：过滤外部内容中的可疑模式……**这层防御容易被措辞变体绕过，
 *     只能作为辅助手段。**」
 * 所以这不是「漏了一种模式」，是这层防御的结构性上限。
 *
 * 关键差别不在「更准」，而在**失败方向**：
 *   黑名单：遇到未知污染形状 → 泄漏进 goal → 状态栏说假话（fail open）
 *   白名单：遇到未知形状 → 不满足资格 → 忽略（fail closed）
 * chapter2.md:847 说模型「几乎无条件地相信状态栏」，越过约 10% 容错线
 * 「比不带还糟」。在这种不对称代价下，必须选 fail closed。
 *
 * 资格判据用**结构事实**，不是语义猜测（evidence-hygiene:125-140：
 * 「按像不像判是语义判断，写成正则一定既漏又误伤」）：
 *   1. 含成句内容——CJK 文字，或 ≥2 个字母单词
 *   2. 不是整行被括号/标记包裹的机器提示
 *   3. 不是 `键: 值` 清单行、标题行、列表项、路径、XML 标签
 */
function _isPlausibleUserSentence(line) {
  const s = String(line || "").trim();
  if (s.length < 2) return false;
  // 整行被机器标记包裹：[...] (...) <<<...>>> {{...}} %%%...%%%
  // 这类形状的共性是「行首和行尾成对的非文字符号」，不是某个具体文案。
  if (/^[[(<{%]/.test(s) && /[\])>}%]$/.test(s)) return false;
  // 省略号包裹的截断提示：「…… 省略后 30 条 ……」
  if (/^[…\.]{2,}/.test(s) && /[…\.]{2,}$/.test(s)) return false;
  if (_looksLikeMetaLine(s)) return false;
  // 正面资格：得有成句的内容。CJK 一个字就算，拉丁字母要求两个以上单词，
  // 否则 "PASS" / "TRUNCATED" 这类单词标记会蒙过去。
  if (/[\u4e00-\u9fa5\u3040-\u30ff]/.test(s)) return true;
  const words = s.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  return words.length >= 2;
}

/**
 * 从 user 消息里取出真实诉求。
 *
 * 两层：先做黑名单剥离（去掉已知的大块注入），再用白名单逐行筛。
 * 保留两层是照 chapter2.md:685「分层防御」——剥离能处理跨行的结构块，
 * 白名单负责兜住剥离漏掉的未知形状。单独任一层都不够。
 */
function _firstUserGoal(messages, maxGoal) {
  const lim = maxGoal || MAX_GOAL;
  for (const m of messages || []) {
    if (!m || m.role !== "user") continue;
    let t = _contentOf(m).trim();
    if (!t || _isStatusPayload(t)) continue;
    t = _stripInjectedBlocks(t);
    if (!t) continue;
    // Devin Local 续写会话会把整条 harness 摘要放进第一条 user 消息。
    // 白名单认它（≥2 个拉丁词），取第一行人话就会把摘要开头钉成 goal。
    // 桌面 HUD 已滤同一前缀，但那只是给人看的投影；模型看见的是这里。
    // 整条跳过，改抽后面第一条真人 user 话——fail closed，不拆摘要正文。
    if (_isContinuationHarnessMessage(t)) continue;
    // 整条消息只是一行工具结果标记时跳过。
    //
    // 原实现按「首行像工具结果」就丢弃整条消息，于是一行
    // `[tool result truncated…]` 噪音能把后面的真实诉求一起带走。
    // 我一度改成「行数 <= 2」——那是启发式猜测，不是判据，同样会误伤。
    //
    // 正确分工：跨行的结构块交给 _stripInjectedBlocks，单行噪音交给白名单
    // （`[...]` 包裹的行本身就不满足人话资格）。这里只兜「整条消息就是那一行」
    // 这一种情况，判据是精确的、没有猜测成分。
    const onlyLine = t.split("\n").filter((s) => s.trim()).length === 1;
    if (onlyLine && /^\s*(?:\[tool result\b|Tool result\b)/i.test(t)) continue;
    // 白名单：取第一行有「人话资格」的内容。
    //
    // 取**第一**行而不是最后一行：注入块总在前面、用户的话在后面，
    // 但剥离之后剩下的第一行人话就是诉求本身。早期用「取最后一行」做兜底，
    // 在多句诉求时会只取到末句，丢掉真正的主诉。
    const line = t
      .split("\n")
      .map((s) => s.trim())
      .find((s) => _isPlausibleUserSentence(s));
    if (!line) continue;
    return line.replace(/\s+/g, " ").slice(0, lim);
  }
  return "";
}

function _fp(tool, argsText) {
  const raw = `${tool || ""}|${String(argsText || "").slice(0, 500)}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

function _bumpTool(state, name, isError, argsText, body) {
  const tool = String(name || "unknown").slice(0, 64);
  state.execution.totalToolCalls = (state.execution.totalToolCalls || 0) + 1;
  if (!state.execution.byTool) state.execution.byTool = {};
  state.execution.byTool[tool] = (state.execution.byTool[tool] || 0) + 1;
  state.execution.lastTool = tool;
  state.execution.lastToolOk = !isError;
  if (!state.execution.consecutiveFailures) state.execution.consecutiveFailures = {};
  if (isError) {
    state.execution.consecutiveFailures[tool] =
      (state.execution.consecutiveFailures[tool] || 0) + 1;
    const line =
      String(body || "")
        .split("\n")
        .map((s) => s.trim())
        .find((s) => s.length > 0) || "error";
    const errorType = _errorType(body, tool);
    // 如果 _errorType 返回 null（不确定是否为错误），则不置位 lastError
    if (errorType) {
      state.execution.lastError = {
        tool,
        type: errorType,
        detail: line.slice(0, MAX_ERROR_DETAIL),
        attempt: state.execution.consecutiveFailures[tool],
        at: new Date().toISOString(),
      };
    }
    // 同类调用连续失败
    const fingerprint = _fp(tool, argsText);
    const sc = state.execution.sameCall || {
      fingerprint: "",
      tool: "",
      count: 0,
      lastArgsPreview: "",
    };
    if (sc.fingerprint === fingerprint) {
      sc.count = (sc.count || 0) + 1;
    } else {
      sc.fingerprint = fingerprint;
      sc.tool = tool;
      sc.count = 1;
      sc.lastArgsPreview = String(argsText || "").replace(/\s+/g, " ").slice(0, 80);
    }
    state.execution.sameCall = sc;
  } else {
    state.execution.consecutiveFailures[tool] = 0;
    // 成功则打断同类失败 streak
    if (state.execution.sameCall && state.execution.sameCall.tool === tool) {
      state.execution.sameCall = {
        fingerprint: "",
        tool: "",
        count: 0,
        lastArgsPreview: "",
      };
    }
  }
}

/**
 * 真·运行期失败信号：只认「运行时才会产生、源码里不会原样出现」的形状。
 *
 * 为什么需要它：上面的 looksLikeCode 豁免会把「输出像代码」的一律放行，
 * 但真实报错也常常**夹带**代码（Python traceback 里就有源码行）。若只看
 * looksLikeCode 就放行，等于把真错误也漏掉。所以豁免要再过这一道：
 * 输出里有没有**运行期特征**——带行号的 traceback、非零退出码、
 * shell 的 command not found 等。这些不会出现在被 grep 的源码字面量里。
 */
function _hasRuntimeFailureSignal(text) {
  const t = String(text || "");
  return (
    /Traceback \(most recent call last\)/.test(t) ||
    /^\s*File ".+", line \d+/m.test(t) ||
    /\b(?:Error|Exception):\s+\S/.test(t) ||       // "TypeError: x is not a function"
    /\bexit (?:code|status)[=: ]+[1-9]\d*\b/i.test(t) ||
    /^Exit code: [1-9]\d*/m.test(t) ||
    /^\s*(?:bash|sh|zsh):.*(?:command not found|No such file)/m.test(t) ||
    /^fatal:/m.test(t)                             // git fatal
  );
}

function _errorType(body, toolName) {
  const t = String(body || "");
  
  // P0 防投毒：工具返回的**代码内容**不算错误。
  //
  // 根因是自举：错误分类器的判据是「文本里有没有 ENOENT / no such file」，
  // 而当被观测的输出**正是错误处理代码本身**时，它匹配到的是自己的源码字面量。
  // 实测（2026-08-11 本会话）：
  //   grep agent_status.js      → "Found 32 match(es)" 被记成 FileNotFound
  //   read agent_status.js      → "<file-view ...>"    被记成 FileNotFound
  //   exec git diff（含本补丁） → "Output from command..." 被记成 FileNotFound
  // 第三例说明豁免不能只按工具名给「代码类工具」——exec 输出 diff 同样中招，
  // 判据必须落在**输出长得像代码**上。
  //
  // 取舍：宁可漏报，不可谎报。漏一次错误只是少一条提示（agent 自己会看到工具
  // 结果）；谎报一次会让状态栏变成假权威，而模型几乎无条件相信状态栏
  // （ai-agent-book ch2 状态栏研究），错值原样传进最终答案。
  // 参考：~/agent-memory/10_knowledge/evidence-hygiene-three-failure-shapes.md 形状三
  const looksLikeCode =
    /\bfunction\b|\bclass\b|\bconst\b|\blet\b|\bvar\b|\bdef\b/.test(t) ||
    /^\s*(?:\/\/|\/\*|\*|#)\s/m.test(t) ||          // 注释行
    /<file-view|line \d+:/i.test(t) ||               // read/grep 的成功外壳
    /Found \d+ match\(es\)/i.test(t) ||              // grep 成功标志
    /^(?:diff --git|@@ -\d|[+-]{3} [ab]\/)/m.test(t) || // diff 片段
    /^Output from command in shell/m.test(t);        // exec 成功外壳
  if (looksLikeCode && !_hasRuntimeFailureSignal(t)) {
    return null; // 判不准 → 不置位 lastError
  }
  
  if (/ENOENT|no such file/i.test(t)) return "FileNotFound";
  if (/EACCES|permission denied/i.test(t)) return "PermissionDenied";
  if (/command not found|not found/i.test(t)) return "CommandNotFound";
  if (/Traceback|Exception|TypeError|ReferenceError/i.test(t)) return "RuntimeError";
  if (/FAILED|FAIL\b|exit[_ ]code[=: ]*[1-9]/i.test(t)) return "CommandFailed";
  if (/timeout|ETIMEDOUT/i.test(t)) return "Timeout";
  if (/\[ERROR\]/i.test(t)) return "ToolError";
  return "Error";
}

function _looksLikeTestCommand(name, argsText, resultText) {
  // P0 防投毒：操作（读/搜/列/量/打印）测试文件 ≠ 跑测试
  //
  // bce7388 只对 read/grep/code_search/find_file/webfetch 豁免，exec 不在其中。
  // 实测（2026-08-11）：
  //   exec wc -l test/prompt-cache-policy.test.js  → testRuns=1 / passed
  //   exec ls test/                                 → testRuns=1 / passed
  //   exec cat test/agent-status.test.js            → testRuns=1 / passed
  // 根因：兜底分支 /\btest[s]?\/|\.test\.|\.spec\./  匹配路径字符串，而路径
  // 出现在 exec 的 args（命令文本）里，于是「访问测试文件」被误判为「跑了测试」。
  //
  // 修法：扩大豁免到 exec —— 如果命令参数含 .test./.spec./test/ 路径，
  // 但命令本身不包含测试框架可执行名（pytest/jest/…），判为操作而非执行。
  //
  // 参考：~/agent-memory/10_knowledge/evidence-hygiene-three-failure-shapes.md 形状三
  const hasTestPath = /\.test\.|\.spec\.|\/test\/|\/tests\//.test(argsText || "");
  const isFileOp = /\b(read|grep|code_search|find_file|webfetch|wc|ls|cat|head|tail|cp|mv|rm)\b/i.test(name);
  if (isFileOp && hasTestPath) return false;

  // exec 的命令参数含测试文件路径 → 区分「操作」和「执行」
  const isExec = /\b(exec|exec_command|shell|bash|run_command)\b/i.test(name);
  const frameworkRe = /\b(pytest|jest|vitest|mocha|phpunit|cargo test|npm test|pnpm test|yarn test|unittest|run[_-]?tests?)\b/i;
  if (isExec && hasTestPath) {
    // 含测试框架可执行名 → 执行测试
    if (frameworkRe.test(argsText || "")) return true;
    // node/python 直接执行 .test.js / .test.ts / .spec.js 文件 → 执行测试
    if (/\b(?:node|ts-node|bun)\b.+\.(?:test|spec)\.[cm]?[jt]s\b/i.test(argsText || "")) return true;
    if (/\b(?:python3?)\b.+\.(?:test|spec)\.py\b/i.test(argsText || "")) return true;
    // 其余（wc、ls、cat、head、cp 等）含测试路径 → 操作，不是执行
    return false;
  }

  const blob = `${name || ""} ${argsText || ""} ${String(resultText || "").slice(0, 400)}`.toLowerCase();
  return (
    frameworkRe.test(blob) ||
    // 不再匹配裸 test/ 或 .test. 路径——那只说明「涉及测试文件」，不是「运行测试」
    // 保留对 go test 的兼容（已在 frameworkRe 里）
    false
  );
}

function _looksLikeSearch(name, argsText) {
  const blob = `${name || ""} ${argsText || ""}`.toLowerCase();
  return /\b(web_search|webfetch|browser|code_search|grep|search|find_file)\b/.test(
    blob,
  );
}

/**
 * 「这一行是运行时栈帧/宿主噪音，不是测试身份」。
 *
 * 9.9.425 实测：`failed_tests: ["throw error;"]`——那是 Node 崩溃栈的一行，
 * 拿它去「focus on failing tests」毫无信息量。同批还抓到过
 * `"Output from command in shell 98fcf0:"`（shell 头部行）和
 * `"… (19 lines truncated)"`（截断提示）。
 *
 * 失败条目的价值在于**可复核**：能据此定位到某个测试。栈帧、宿主装饰行、
 * 截断提示都不满足，宁可留空也不要填这类字符串——空表示「没抓到身份」，
 * 假身份会把注意力引到不存在的地方。
 */
function _looksLikeStackNoise(line) {
  const s = String(line || "").trim();
  if (!s) return true;
  if (/^at\s/.test(s)) return true;
  if (/^node:internal/.test(s)) return true;
  if (/^throw\s/.test(s)) return true;
  if (/^\^+$/.test(s)) return true;
  if (/^[{}\[\],]+$/.test(s)) return true;
  if (/^(?:code|actual|expected|operator|diff|generatedMessage):/.test(s)) return true;
  if (/^Output from command in shell\b/i.test(s)) return true;
  if (/^…?\s*\(\d+ lines truncated\)/i.test(s)) return true;
  if (/^Exit code:/i.test(s)) return true;
  if (/^Node\.js v/i.test(s)) return true;
  return false;
}

// ANSI 转义序列。测试框架的彩色输出会把 `FAIL` 包成 `\x1b[31mFAIL\x1b[0m`，
// 不剥离就会被原样抓进 failedTests——状态栏里出现乱码般的转义码，
// 而且让「按名字定位测试」彻底失效。
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function _parseTestOutcome(resultText) {
  const t = String(resultText || "").replace(ANSI_RE, "");
  const lower = t.toLowerCase();
  const failed = [];
  const failRe = /(?:FAIL|FAILED|✗|×)\s+([^\n]{3,120})/gi;
  let m;
  while ((m = failRe.exec(t)) && failed.length < MAX_FAILED_TESTS) {
    const entry = m[1].trim().slice(0, 100);
    if (!_looksLikeStackNoise(entry)) failed.push(entry);
  }
  const nonzeroExit = /\bexit[_ ]code[=: ]*[1-9]\d*\b/i.test(t);
  const nonzeroFailedCount = /\b[1-9]\d*\s+(?:failed|failures?)\b/i.test(lower);
  // explicitSuccess：只认测试框架的结构化摘要输出，不接受裸 "pass"/"ok" 子串。
  //
  // 2026-08-11 实测：/\bpass(?:ed)?\b/i 会命中 "bypass"；
  // /\b(?:tests?\s+)?ok\b/i 命中 "looks ok to me"；
  // /\bexit[_ ]code[=: ]*0\b/i 命中任何成功命令（exit 0 只说明命令成功，
  // 不代表跑了测试）。
  //
  // 正确判据：只认测试框架会输出的结构化摘要行：
  //   "N passed"（pytest / jest / vitest）
  //   "all tests passed"
  //   "0 failed" / "0 failures"
  //   "Tests: N passed" / "Test Suites: N passed"（jest）
  //   "ok" 行前必须有 test 关键词（"tests ok" / "test suite ok"）
  //
  // 参考：bce7388 论据 + evidence-hygiene-three-failure-shapes.md 形状一（计数≠证据）
  const explicitSuccess =
    /\ball tests passed\b/i.test(lower) ||
    /\b0\s+(?:failed|failures?)\b/i.test(lower) ||
    /\b\d+\s+passed\b/i.test(lower) ||
    /\btests?:\s+\d+\s+passed\b/i.test(lower) ||
    /\btest suites?:\s+\d+\s+passed\b/i.test(lower) ||
    /\btests?\s+(?:suite\s+)?ok\b/i.test(lower);
  const hasFailSignal =
    nonzeroExit ||
    nonzeroFailedCount ||
    (!explicitSuccess &&
      (/\b(failed|failures?)\b/i.test(lower) ||
        (/\berror\b/i.test(lower) && /\btest\b/i.test(lower))));
  if (hasFailSignal) {
    if (!failed.length) {
      // 兜底也必须过噪音闸门。原实现只做 /error|fail/ 关键词命中，于是
      // Node 崩溃栈的 "  throw error;" 成了 failedTests 唯一条目——
      // 实测状态栏据此建议「focus on failing tests: throw error;」，
      // 把注意力引向一个不存在的测试。
      //
      // 这正是 gate-covers-only-its-return-value 的同一形状：主路径加了
      // 过滤，旁路（兜底分支）没加，旁路就成了绕过闸门的后门。
      // 抓不到可复核身份时留空——空表示「不知道是哪条」，比假身份诚实。
      const line = t
        .split("\n")
        .find((l) => /error|fail/i.test(l) && !_looksLikeStackNoise(l));
      if (line) failed.push(line.trim().slice(0, 100));
    }
    return { status: "failed", failedTests: failed };
  }
  if (explicitSuccess) {
    return { status: "passed", failedTests: [] };
  }
  return null;
}

function _parseTodoWrite(argsText) {
  if (!argsText) return null;
  try {
    const obj = JSON.parse(argsText);
    const list = obj.todos || obj.items || obj.todo || null;
    if (!Array.isArray(list)) return null;
    return list.slice(0, MAX_TODOS).map((t, i) => ({
      id: String(t.id || t.name || `t${i + 1}`).slice(0, 40),
      content: String(t.content || t.title || t.text || "").slice(0, 80),
      status: String(t.status || "pending").toLowerCase(),
    }));
  } catch (_) {
    return null;
  }
}

function _resetExecutionCounters(state) {
  state.execution.totalToolCalls = 0;
  state.execution.byTool = {};
  state.execution.consecutiveFailures = {};
  state.execution.sameCall = {
    fingerprint: "",
    tool: "",
    count: 0,
    lastArgsPreview: "",
  };
  state.execution.lastError = null;
  state._seenToolResultIds = {};
  state._msgWatermark = 0;
}

/**
 * 从 messages 轨迹用代码刷新状态
 */
function observeMessages(state, messages, opts) {
  if (!state || !Array.isArray(messages)) return state;
  const maxGoal = (opts && opts.maxGoalChars) || MAX_GOAL;

  if (!state.goal) {
    const g = _firstUserGoal(messages, maxGoal);
    if (g) state.goal = g;
  }

  const watermark = state._msgWatermark || 0;
  let start = watermark;
  if (messages.length < watermark) {
    start = 0;
    _resetExecutionCounters(state);
  }

  const idToName = {};
  const idToArgs = {};
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const tcs = m.tool_calls || m.toolCalls || [];
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      const id = tc.id || tc.tool_call_id || "";
      const name = (tc.function && tc.function.name) || tc.name || "tool";
      const args =
        (tc.function && tc.function.arguments) ||
        tc.arguments ||
        tc.input ||
        "";
      if (id) {
        idToName[id] = name;
        idToArgs[id] =
          typeof args === "string" ? args : JSON.stringify(args || {});
      }
      if (String(name).toLowerCase().includes("todo")) {
        const todos = _parseTodoWrite(
          typeof args === "string" ? args : JSON.stringify(args || {}),
        );
        if (todos) state.todos = todos;
      }
    }
  }

  if (!state._seenToolResultIds) state._seenToolResultIds = {};

  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;

    if (m.role === "assistant") {
      const tcs = m.tool_calls || m.toolCalls || [];
      if (Array.isArray(tcs) && tcs.length) {
        for (const tc of tcs) {
          const name =
            (tc.function && tc.function.name) || tc.name || "tool";
          state.execution.lastTool = String(name).slice(0, 64);
        }
      }
      continue;
    }

    if (m.role === "tool" || m.tool_call_id) {
      const id = m.tool_call_id || m.id || `idx:${i}`;
      // 幂等：同一 tool result id 不重复计数
      if (state._seenToolResultIds[id]) continue;
      state._seenToolResultIds[id] = 1;

      const name = idToName[id] || m.name || "tool";
      const body = _contentOf(m);
      // P0 带外元数据判失败：只认工具层设置的带外标记，不做正文嗅探。
      //
      // 根因（2026-08-11 实测）：正文嗅探不受 _errorType 的 looksLikeCode 闸门保护。
      // 当工具成功地返回含错误关键词字面量的源码（grep/read agent_status.js、
      // exec git diff 展示本补丁）时，isError 被置 true，导致：
      //   - lastToolOk = false（工具明明成功）
      //   - consecutiveFailures 被累加（strategy 据此建���"verify path"）
      //   - sameCallFailureStreak 被累加
      // 这三处均不在 _errorType 的返回值路径上，无法被闸门保护。
      //
      // 正确分层：
      //   带外元数据（is_error / tool_result_is_error）→ 由工具层设置，可信
      //   正文嗅探（ENOENT / Traceback …）→ 只用于给已知失败做类型分类，
      //     由 _errorType() 在 _bumpTool 内部处理，不在此处影响 isError
      //
      // 参考：~/agent-memory/10_knowledge/evidence-hygiene-three-failure-shapes.md 形状三
      let isError =
        m.tool_result_is_error === true ||
        m.is_error === true;

      const argsText = idToArgs[id] || "";
      // ⚠ 这里曾经解析 body（工具输出的自由文本）来判断测试有没有通过，
      // 写 verification.{latestTestStatus,failedTests,testRuns,...}。已删除。
      // 详细原因见 _emptyState 处的长注释；一句话版本：stdout 里混着真实结果、
      // 我写的源码、注释和探针打印，任何正则都无法区分它们。
      // B 阶段用带外结构化信号（退出码 / --junitxml / --json）重新接回。

      // 研究类：记录搜索次数（通用 profile 有用）
      if (_looksLikeSearch(name, argsText)) {
        if (!state.execution.searchCalls) state.execution.searchCalls = 0;
        state.execution.searchCalls += 1;
      }

      _bumpTool(state, name, isError, argsText, body);
    }
  }

  state._msgWatermark = messages.length;

  // todos 汇总
  if (Array.isArray(state.todos) && state.todos.length) {
    const cur =
      state.todos.find((t) => /in_progress|doing|active/i.test(t.status)) ||
      state.todos.find((t) => /pending|todo/i.test(t.status));
    state._currentTodo = cur
      ? `${cur.id}${cur.content ? ": " + cur.content : ""}`
      : "none";
    state._todoCompleted = state.todos.filter((t) =>
      /completed|done|complete/i.test(t.status),
    ).length;
    state._todoTotal = state.todos.length;
  } else {
    state._currentTodo = "none";
    state._todoCompleted = 0;
    state._todoTotal = 0;
  }

  _deriveConclusions(state);
  _derivePhase(state);
  state.strategy = _deriveStrategy(state, opts);
  return state;
}

function _deriveConclusions(state) {
  const fails = state.execution.consecutiveFailures || {};
  const maxFail = Math.max(0, ...Object.values(fails).map(Number), 0);
  const openTodos = Math.max(
    0,
    (state._todoTotal || 0) - (state._todoCompleted || 0),
  );
  // 可宣称完成：无未完成 todo，且没有连续失败堆积。
  //
  // 曾经还有一个 testsOk 条件（依赖 verification.latestTestStatus）。随
  // verification 段一并删除——它由文本推断而来，把一份写着「全部通过」的输出
  // 判成 failed，再据此设 verificationBlocking=true，命令我「先修好失败测试」。
  // 而那些「失败测试」正是断言这个字段该消失的用例名。
  // 测试阻塞只由**显式声明**驱动。三态而非二态：
  //   有声明且 failed → true   （明确知道红）
  //   有声明且 passed → false  （明确知道绿）
  //   无声明          → undefined（不知道，不产生任何结论）
  // 第三种绝不塌缩成 false——那就是把「没测到」和「测到是好的」混为一谈，
  // 正是 A 阶段那个毛病本身（synthesis_health.py:16-17 同一口径）。
  const tr = state.testReport;
  const testBlocking = tr ? tr.status === "failed" : undefined;

  const canClaim = openTodos === 0 && maxFail < 3 && testBlocking !== true;

  state.conclusions = {
    canClaimComplete: !!canClaim,
    openTodos,
    maxConsecutiveFailure: maxFail,
    sameCallFailureStreak: (state.execution.sameCall && state.execution.sameCall.count) || 0,
    ...(testBlocking === undefined ? {} : { verificationBlocking: testBlocking }),
  };
}

function _derivePhase(state) {
  const c = state.conclusions || {};
  const by = (state.execution && state.execution.byTool) || {};
  const hasEdit = !!(by.edit || by.write || by.multi_edit || by.Edit || by.Write);
  const tools = state.execution.totalToolCalls || 0;

  // "verified" 这个 phase 曾经由 verification.latestTestStatus === "passed" 驱动，
  // 随 verification 段一并删除。现在没有任何可信来源能证明"已验证"，
  // 所以不再输出这个 phase——宁可少说一档，也不要凭文本推断宣称已验证。
  if (c.canClaimComplete && tools > 0) {
    state.phase = "ready";
  } else if (
    (c.maxConsecutiveFailure || 0) >= 3 ||
    (c.sameCallFailureStreak || 0) >= 2
  ) {
    state.phase = "debugging";
  } else if (tools === 0) {
    state.phase = state.goal ? "planning" : "start";
  } else if (hasEdit) {
    state.phase = "editing";
  } else if ((state.execution.searchCalls || 0) > 0 && !hasEdit) {
    state.phase = "researching";
  } else {
    state.phase = "exploring";
  }
}

/**
 * 软策略：人定义的提醒原则，LLM 决定具体路径
 */
function _deriveStrategy(state, opts) {
  const soft =
    opts && opts.softRules === false
      ? false
      : true;
  if (!soft) return [];

  const hints = [];
  const c = state.conclusions || {};
  const v = state.verification || {};
  const sc = (state.execution && state.execution.sameCall) || {};
  const profile = state.profile || "general";

  if ((sc.count || 0) >= 2) {
    hints.push(
      `Same ${sc.tool || "tool"} call failed ${sc.count} times with equivalent args. Do not retry unchanged; change parameters, path, or approach.`,
    );
  }

  if ((c.maxConsecutiveFailure || 0) >= 3) {
    hints.push(
      "A tool has failed 3+ times consecutively. Diagnose (read error, list dir, check cwd) before another attempt.",
    );
  }

  // 这里曾经有两条由**文本推断**驱动的策略：
  //   "Verification has not passed. …fix failing tests first."
  //   "Focus on failing tests: <failedTests>"
  // 它们是 A 阶段那次事故里唯一真正**改变了我行为**的部分——状态栏把断言
  // 「verification 段应该消失」的用例名列成待修失败测试，再命令我先去修好
  // 它们。读数错了还只是噪音，策略错了就是把人带偏。
  //
  // B 阶段重新给出策略，但只在**有显式声明且声明为 failed** 时。
  // 不再列举「哪些测试失败了」——那需要从文本抓测试名，正是被删掉的能力。
  // 改为给出可复核的坐标（数量 + 框架），让读者自己去跑那个框架核对。
  // chapter2.md:939-947：读数必须配策略才会改变行为，但策略的前提是读数为真。
  const tr = state.testReport;
  if (tr && tr.status === "failed") {
    hints.push(
      `Self-declared test report: ${tr.failed} failed / ${tr.passed} passed (${tr.framework}). ` +
        `Do not claim completion until a new report shows 0 failed.`,
    );
  }

  if ((c.openTodos || 0) > 0) {
    hints.push(
      `Open todos remain (${c.openTodos}). Prefer advancing the current todo over starting unrelated work or finishing early.`,
    );
  }

  if (!state.environment || !state.environment.cwd) {
    hints.push(
      "Working directory is unknown. Prefer absolute paths or confirm cwd before file/shell operations.",
    );
  }

  if (profile === "research") {
    if ((state.execution.searchCalls || 0) >= 2 && (state.execution.totalToolCalls || 0) === (state.execution.searchCalls || 0)) {
      hints.push(
        "Multiple searches done with no synthesis yet. Start drafting findings and mark evidence gaps instead of only searching more.",
      );
    }
    if ((state.execution.searchCalls || 0) >= 2) {
      hints.push(
        "Do not conclude 'no information exists' after few searches; try alternate keywords/sources or explicitly list remaining gaps.",
      );
    }
  }

  if (state.execution && state.execution.lastError) {
    const e = state.execution.lastError;
    if (e.type === "FileNotFound") {
      hints.push(
        "Last error was FileNotFound: verify path, list parent directory, or use an absolute path under the workspace.",
      );
    }
  }

  // 预算/完成
  if (c.canClaimComplete) {
    hints.push(
      "Hard facts currently allow completion claims (no blocking failed verification / no open todos). Still verify user acceptance criteria before final delivery.",
    );
  }

  return hints.slice(0, MAX_STRATEGY);
}

function renderStatusBar(state) {
  const env = state.environment || {};
  const ex = state.execution || {};
  const v = state.verification || {};
  const route = state.route || {};
  const c = state.conclusions || {};
  // 只有显式声明过才有值；undefined 时整段不渲染（见下方 test_report 段）
  const tr = state.testReport;
  const fails = ex.consecutiveFailures || {};
  const failLines = Object.entries(fails)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, n]) => `    ${k}: ${n}`)
    .join("\n");

  const by = ex.byTool || {};
  const topTools = Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `    ${k}: ${n}`)
    .join("\n");

  const sc = ex.sameCall || {};
  const err = ex.lastError;
  const errBlock = err
    ? [
        "last_error:",
        `  tool: ${err.tool}`,
        `  type: ${err.type}`,
        `  attempt: ${err.attempt}`,
        `  detail: ${JSON.stringify(err.detail || "")}`,
      ].join("\n")
    : "last_error: none";

  const strategy = Array.isArray(state.strategy) ? state.strategy : [];
  const strategyLines = strategy.length
    ? strategy.map((s, i) => `  - ${JSON.stringify(s)}`).join("\n")
    : "  - none";

  return [
    STATUS_MARKER,
    `<${TAG} version="${state.version || 0}" profile="${state.profile || "general"}">`,
    "# 真实读数 (Harness 代码维护 · 勿臆测改写)",
    "task:",
    `  goal: ${JSON.stringify(state.goal || "")}`,
    `  phase: ${state.phase || "start"}`,
    "",
    "todo:",
    `  completed: ${state._todoCompleted || 0}/${state._todoTotal || 0}`,
    `  current: ${JSON.stringify(state._currentTodo || "none")}`,
    "",
    "environment:",
    `  cwd: ${JSON.stringify(env.cwd || "")}`,
    `  os: ${env.os || process.platform}`,
    env.gitBranch ? `  git_branch: ${JSON.stringify(env.gitBranch)}` : null,
    "",
    "execution:",
    `  total_tool_calls: ${ex.totalToolCalls || 0}`,
    `  search_calls: ${ex.searchCalls || 0}`,
    `  last_tool: ${ex.lastTool || "none"}`,
    `  last_tool_ok: ${ex.lastToolOk == null ? "n/a" : ex.lastToolOk}`,
    "  consecutive_failures:",
    failLines || "    none: 0",
    "  same_call_failures:",
    `    tool: ${sc.tool || "none"}`,
    `    count: ${sc.count || 0}`,
    sc.lastArgsPreview
      ? `    args_preview: ${JSON.stringify(sc.lastArgsPreview)}`
      : null,
    "  tools:",
    topTools || "    none: 0",
    "",
    errBlock,
    "",
    // 旧的 verification: 段（latest_test_status / test_runs /
    // consecutive_test_failures / failed_tests）已在 A 阶段删除——它由文本推断
    // 而来，是那次事故里唯一被模型读到的部分。
    //
    // 这里是 B 阶段的替代：只在**有显式声明**时才渲染，并强制标注
    // source=declared。标注不是装饰——它让读者知道这一格的可信度低于
    // total_tool_calls 那类计数器读数（chapter2.md:857：越是来自对外部世界的
    // 真实观测，价值越高）。声明可能是谎报，但不会被无关文本污染。
    ...(tr
      ? [
          "test_report:  # 模型自报 · 非 harness 观测",
          `  status: ${tr.status}`,
          `  passed: ${tr.passed}`,
          `  failed: ${tr.failed}`,
          `  framework: ${tr.framework}`,
          `  source: self-declared`,
          "",
        ]
      : []),
    "# 已计算结论 (代码推导)",
    "conclusions:",
    `  can_claim_complete: ${!!c.canClaimComplete}`,
    `  open_todos: ${c.openTodos || 0}`,
    `  max_consecutive_failure: ${c.maxConsecutiveFailure || 0}`,
    `  same_call_failure_streak: ${c.sameCallFailureStreak || 0}`,
    "",
    "# 软策略 (原则提醒 · 具体路径由你选择)",
    "strategy:",
    strategyLines,
    "",
    "route:",
    `  model_uid: ${route.modelUid || ""}`,
    `  provider: ${route.provider || ""}`,
    `  upstream: ${route.upstreamModel || ""}`,
    `</${TAG}>`,
  ]
    .filter((line) => line != null)
    .join("\n");
}

function injectIntoMessages(messages, state) {
  const cleaned = stripStatusMessages(messages);
  const bar = renderStatusBar(state);
  cleaned.push({
    role: "user",
    content: bar,
    _daoAgentStatus: true,
  });
  return cleaned;
}

function _guessGitBranch(cwd) {
  if (!cwd) return "";
  try {
    const head = path.join(cwd, ".git", "HEAD");
    const raw = fs.readFileSync(head, "utf8").trim();
    const m = raw.match(/ref:\s*refs\/heads\/(.+)/);
    if (m) return m[1].trim();
    return raw.slice(0, 12);
  } catch (_) {
    return "";
  }
}

function prepareOutbound(opts) {
  const {
    key,
    identityKind = "derived",
    identityId = "",
    messages,
    modelUid = "",
    provider = "",
    upstreamModel = "",
    workspaceRoots = [],
    injectOutbound,
    cfg = null,
  } = opts || {};

  const cleaned = stripStatusMessages(messages);
  if (!isEnabled(cfg)) {
    return { messages: cleaned, state: null, injected: false };
  }
  if (!Array.isArray(cleaned) || cleaned.length === 0) {
    return { messages: cleaned, state: null, injected: false };
  }

  const as = _cfgAgentStatus(cfg);
  const sessionKey = key || "anon";
  const state = _load(sessionKey);
  state.mode = state.mode || _defaultMode(cfg);
  if (state.mode === "off") {
    _emit(state);
    return { messages: cleaned, state: null, injected: false };
  }
  state.key = sessionKey;
  // identity 只在入参真的带了信息时才覆写。
  // 原实现无条件重写：调用方没传 identityKind/identityId 时（例如只想刷新一次
  // 状态），已保存的 native 身份会被降级成 derived、id 被替换成 session key。
  // 而 agent-hud 的设计明确要求「原生 ID 和派生 ID 不得合并」，降级会让多会话
  // 投影把两个不同来源的会话当成同一个。缺省入参属于「没有新信息」，不是
  // 「身份变成 derived」——两者必须分开。
  const hasIdentityInput = identityKind === "native" || !!identityId;
  if (hasIdentityInput || !state.identity || !state.identity.id) {
    state.identity = {
      kind: identityKind === "native" ? "native" : "derived",
      id: String(identityId || key || "anon").replace(/^dao:/, ""),
    };
  }
  state.activity.requestInFlight = true;
  state.activity.lastRequestAt = _now();

  // cwd 三级兜底：调用方入参 → 已知值 → 从 Harness 注入的 system_info 里提取。
  // 第三级是本会话实测补的：ACP/多根工作区下 workspaceRoots 为空，而 cwd 就明明
  // 白白写在注入块里（`/path/to/workspace (cwd)`）。少了这一级，状态栏一边挂着
  // 「Working directory is unknown」，一边记着上百次成功的 exec。
  const cwd =
    (Array.isArray(workspaceRoots) && workspaceRoots[0]) ||
    state.environment.cwd ||
    _cwdFromInjectedInfo(cleaned) ||
    "";
  state.environment.cwd = cwd;
  state.environment.os = process.platform;
  if (cwd) {
    const br = _guessGitBranch(cwd);
    if (br) state.environment.gitBranch = br;
  }

  const previousRoute = state.route || {};
  if (modelUid && modelUid !== previousRoute.modelUid) {
    state.route = {
      modelUid,
      provider: provider || "",
      upstreamModel: upstreamModel || "",
      provisional: true,
    };
  } else if (
    previousRoute.provisional !== false &&
    !previousRoute.provider &&
    provider
  ) {
    state.route = {
      modelUid: modelUid || previousRoute.modelUid || "",
      provider,
      upstreamModel: upstreamModel || "",
      provisional: true,
    };
  }

  const observeOpts = {
    maxGoalChars: (as && as.maxGoalChars) || MAX_GOAL,
    softRules: as && as.softRules === false ? false : true,
  };

  observeMessages(state, cleaned, observeOpts);
  state.profile = _profileOf(cfg, state);
  // profile 变化后重算策略
  state.strategy = _deriveStrategy(state, observeOpts);
  _applyActivation(state, cfg);

  _save(state);
  if (state.activation.state !== "active") {
    return { messages: cleaned, state, injected: false };
  }
  // Cache-sensitive routes can keep local session state without rewriting the
  // model-visible suffix on every turn. This preserves an append-only prompt
  // prefix while retaining Dao Flow's local current-work projection.
  if (injectOutbound === false || (as && as.injectOutbound === false)) {
    return { messages: cleaned, state, injected: false };
  }
  return {
    messages: injectIntoMessages(cleaned, state),
    state,
    injected: true,
  };
}

function _publicSummary(state, observedAt = state.updatedAt || 0) {
  const execution = state.execution || {};
  const verification = state.verification || {};
  const conclusions = state.conclusions || {};
  const route = state.route || {};
  return {
    key: state.key,
    version: state.version || 0,
    updatedAt: state.updatedAt || 0,
    observedAt,
    identity: {
      ...(state.identity || { kind: "derived", id: state.key }),
    },
    mode: state.mode || "auto",
    activation: {
      ...(state.activation || {
        state: "dormant",
        reason: "",
        activatedAt: 0,
      }),
    },
    activity: { ...(state.activity || {}) },
    goal: String(state.goal || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120),
    phase: state.phase || "start",
    todo: {
      completed: state._todoCompleted || 0,
      total: state._todoTotal || 0,
      current: String(state._currentTodo || "none").slice(0, 100),
    },
    // verification 段已删除（见 _emptyState 处的长注释）。
    // 下游消费者（agent-hud / web-hud 投影）若引用 summary.verification，
    // 会得到 undefined —— 这是有意的：宁可让消费端显式处理缺失，
    // 也不要继续供给一个由文本推断出来的假读数。
    failures: {
      maxConsecutive: conclusions.maxConsecutiveFailure || 0,
      sameCallStreak: conclusions.sameCallFailureStreak || 0,
      lastToolOk: execution.lastToolOk,
      hasLastError: !!execution.lastError,
    },
    route: {
      modelUid: String(route.modelUid || ""),
      provider: String(route.provider || ""),
      upstreamModel: String(route.upstreamModel || ""),
      provisional: route.provisional === true,
    },
    workspace: path.basename(
      (state.environment && state.environment.cwd) || "",
    ),
  };
}

function _emit(state) {
  const observedAt = _now();
  for (const listener of [..._listeners]) {
    try {
      listener(_publicSummary(state, observedAt));
    } catch (_) {}
  }
}

function onDidUpdate(listener) {
  if (typeof listener !== "function") return { dispose() {} };
  _listeners.add(listener);
  return {
    dispose() {
      _listeners.delete(listener);
    },
  };
}

function listSummaries() {
  const observedAt = _now();
  return [..._mem.values()].map((state) => _publicSummary(state, observedAt));
}

function summary(key) {
  return _publicSummary(_load(key));
}

function setMode(key, mode, cfg) {
  const state = _load(key);
  const previous = JSON.parse(JSON.stringify(state));
  state.mode = _normalizeMode(mode);
  if (state.mode === "auto") {
    state.activation = { state: "dormant", reason: "", activatedAt: 0 };
  }
  _applyActivation(state, cfg);
  if (!_save(state, { emitOnFailure: false })) {
    _mem.set(key, previous);
    return null;
  }
  return _publicSummary(state, _now());
}

/**
 * 记录模型**显式声明**的测试结果。零解析、零推断。
 *
 * 这是 A 阶段删掉 verification 段后的替代方案。为什么不用退出码或
 * --junitxml（上一轮的原计划，已证伪）：
 *   cascade_wire.js:86-102 列出协议 ChatMessagePrompt 全部字段，唯一的带外
 *   错误信号是 TOOL_RESULT_IS_ERROR（bool），**没有退出码**。实测
 *   `ls /nonexistent` 退出码 1 而状态栏 last_tool_ok 仍是 true——工具层没把
 *   非零退出码映射成 is_error。而本模块在代理层，只看消息流、从不执行进程，
 *   给 pytest 加 --junitxml 再读结果文件是 harness 本体的能力，不在射程内。
 *
 * 改用书里 TODO 的同一模式（ai-agent-book/chapter2/system-hint/agent.py:787
 * _tool_update_todo_status）：模型显式调工具声明 → 代码原样记录 → 零推断。
 * 参考实现里唯一带「状态」的字段就是 TODO，它的值也不是 harness 猜出来的。
 *
 * 代价要写明：声明**不可复核**——模型可以谎报。所以渲染层必须标注
 * source=declared，让读者知道这一格的可信度低于计数器类读数
 * （chapter2.md:857「状态栏注入的信息越是来自对外部世界的真实观测，
 *   价值越高」——声明比文本推断可靠，但仍不如真实观测）。
 * 相比文本推断的改进在于：声明**不会被无关文本污染**，
 * 判据是「有没有人明确说」而不是「文本里像不像」。
 *
 * 非法声明一律拒绝并返回 null，绝不落脏数据——宁可 unknown。
 */
function recordTestReport(key, report) {
  if (!key) return null;
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const passed = report.passed;
  const failed = report.failed;
  // 两个计数都必须是明确给出的非负有限整数。缺一个就拒绝——
  // 「只说通过数不说失败数」无法判断绿红，那是残缺声明，不是部分信息。
  const ok = (n) =>
    typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
  if (!ok(passed) || !ok(failed)) return null;

  const state = _load(key);
  state.testReport = {
    passed,
    failed,
    framework: String(report.framework || "unknown").slice(0, 40),
    status: failed > 0 ? "failed" : "passed",
    at: _now(),
    source: "declared",
  };
  state.activity.lastUpdateAt = _now();
  _deriveConclusions(state);
  state.strategy = _deriveStrategy(state, { softRules: true });
  _save(state);
  return state;
}

function recordRoute(key, route) {
  if (!key) return null;
  const state = _load(key);
  state.route = { ...state.route, ...route, provisional: false };
  state.activity.requestInFlight = false;
  state.activity.lastUpdateAt = _now();
  _save(state);
  return _publicSummary(state, _now());
}

function finishRequest(key) {
  if (!key) return null;
  const state = _load(key);
  state.activity.requestInFlight = false;
  state.activity.lastUpdateAt = _now();
  _save(state);
  return _publicSummary(state, _now());
}

function options(cfg) {
  const as = _cfgAgentStatus(cfg);
  const auto = (as && as.auto) || {};
  const hud = (as && as.hud) || {};
  return {
    enabled: isEnabled(cfg),
    defaultMode: _defaultMode(cfg),
    auto: {
      minToolCalls: Math.max(
        1,
        Number(auto.minToolCalls) || DEFAULT_AUTO_TOOL_CALLS,
      ),
      activateAfterMs: Math.max(
        1_000,
        Number(auto.activateAfterMs) || DEFAULT_AUTO_AFTER_MS,
      ),
    },
    hud: {
      enabled: hud.enabled !== false,
      activeTtlMs: Math.max(
        1_000,
        Number(hud.activeTtlMs) || 120_000,
      ),
      staleTtlMs: Math.max(
        1_000,
        Number(hud.staleTtlMs) || 7_200_000,
      ),
    },
  };
}

function clear(key) {
  if (!key) return;
  _mem.delete(key);
  try {
    fs.unlinkSync(_filePath(key));
  } catch (_) {}
}

module.exports = {
  isEnabled,
  prepareOutbound,
  observeMessages,
  renderStatusBar,
  injectIntoMessages,
  stripStatusMessages,
  summary,
  setMode,
  listSummaries,
  onDidUpdate,
  recordRoute,
  recordTestReport,
  finishRequest,
  options,
  clear,
  STATUS_MARKER,
  _load,
  _save,
  _emptyState,
  _deriveStrategy,
  _deriveConclusions,
  _test: {
    setNow(fn) {
      _nowImpl = fn;
    },
    resetNow() {
      _nowImpl = () => Date.now();
    },
    publicSummary: _publicSummary,
    autoReason: _autoReason,
  },
};
