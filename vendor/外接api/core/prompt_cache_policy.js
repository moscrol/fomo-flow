"use strict";

const crypto = require("node:crypto");

const AGENT_STATUS_MARKER = "<!--dao-agent-status-->";
const CHECKPOINT_MARKER = "<!-- DAO-CONTEXT-CHECKPOINT -->";
const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WARMUP_AFTER_MS = 240_000;
const DEFAULT_WARMUP_MIN_TOKENS = 16_000;
const DEFAULT_WARMUP_MAX_PER_HOUR = 2;
const ANTHROPIC_CACHEABLE_TYPES = new Set([
  "text",
  "tool_result",
  "tool_use",
  "image",
]);
const OPENAI_CHAT_CACHEABLE_TYPES = new Set([
  "text",
  "image_url",
  "input_audio",
  "file",
  "refusal",
]);
const OPENAI_RESPONSES_CACHEABLE_TYPES = new Set([
  "input_text",
  "input_image",
  "input_file",
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value || null), "utf8")
    .digest("hex")
    .slice(0, 12);
}

function positiveNumber(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function normalizeSettings(value) {
  const settings = value && typeof value === "object" ? value : {};
  const warmup = settings.warmup && typeof settings.warmup === "object"
    ? settings.warmup
    : {};
  return {
    enabled: settings.enabled !== false,
    anthropicTtl: settings.anthropicTtl === "1h" ? "1h" : "5m",
    openaiMode: settings.openaiMode === "explicit" ? "explicit" : "implicit",
    openaiTtl: "30m",
    openaiTtlDowngrade:
      settings.openaiTtl != null && settings.openaiTtl !== "30m",
    // 消息级 breakpoint 的最小保护规模（token）。
    // null = 未配置，由 decorate 阶段按模型分档解析（minCacheableTokens）；
    // 显式设 0 = 不设门槛，保留旧行为，便于做对照实验。
    // 这里不能直接填默认值：默认值依赖 model，而 model 在 plan 而非 settings 里。
    minBreakpointTokens: Number.isFinite(Number(settings.minBreakpointTokens))
      && Number(settings.minBreakpointTokens) >= 0
      ? Number(settings.minBreakpointTokens)
      : null,
    legacyRetention:
      settings.legacyRetention === "24h" || settings.legacyRetention === "in_memory"
        ? settings.legacyRetention
        : null,
    warmup: {
      enabled: warmup.enabled === true,
      afterMs: positiveNumber(warmup.afterMs, DEFAULT_WARMUP_AFTER_MS, 1_000),
      minStableTokens: positiveNumber(
        warmup.minStableTokens,
        DEFAULT_WARMUP_MIN_TOKENS,
      ),
      maxPerHour: positiveNumber(
        warmup.maxPerHour,
        DEFAULT_WARMUP_MAX_PER_HOUR,
      ),
    },
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      return block.text || block.output || block.content || "";
    })
    .join("\n");
}

function itemText(item) {
  if (!item || typeof item !== "object") return "";
  return contentText(item.content || item.output || "");
}

function isVolatile(item) {
  const text = itemText(item);
  return text.includes(AGENT_STATUS_MARKER) || text.includes(CHECKPOINT_MARKER);
}

function isCheckpoint(item) {
  return itemText(item).includes(CHECKPOINT_MARKER);
}

function candidateIndices(items, isCandidate) {
  const volatile = [];
  for (let index = 0; index < items.length; index++) {
    if (isVolatile(items[index])) volatile.push(index);
  }
  const candidates = [];
  if (!volatile.length) {
    for (let index = items.length - 1; index >= 0; index--) {
      if (isCandidate(items[index])) {
        candidates.push(index);
        break;
      }
    }
    return candidates;
  }

  for (const volatileIndex of volatile) {
    for (let index = volatileIndex - 1; index >= 0; index--) {
      if (isVolatile(items[index])) break;
      if (isCandidate(items[index])) {
        if (!candidates.includes(index)) candidates.push(index);
        break;
      }
    }
  }
  const finalVolatile = volatile[volatile.length - 1];
  for (let index = items.length - 1; index > finalVolatile; index--) {
    if (isCandidate(items[index])) {
      if (!candidates.includes(index)) candidates.push(index);
      break;
    }
  }
  return candidates.sort((a, b) => a - b);
}

function limitCandidates(indices, limit) {
  if (limit <= 0 || !indices.length) return [];
  if (indices.length <= limit) return indices;
  if (limit === 1) return [indices[indices.length - 1]];
  return [indices[0], ...indices.slice(-(limit - 1))];
}

/**
 * 消息级 breakpoint 的最小规模门槛。
 *
 * 依据（Anthropic 官方 + Bedrock 模型卡，2026-08-11 核对）：可缓存前缀有
 * **文档化的最小 token 数**，且按模型分档——
 *     Sonnet 4.6                  1,024
 *     Opus 4.5/4.6、Haiku 4.5     4,096
 * 低于该值时：**请求照常成功、按全价计费、静默不缓存**，`cache_creation_
 * input_tokens` 返回 0，没有任何报错。
 *
 * 所以门槛的正当性**不是**「省下 1.25x 的写入费」——sub-minimum 的 breakpoint
 * 压根不产生写入，它是个 no-op。真正的理由有两条：
 *   1. **槽位是稀缺资源**：每请求上限 4 个 breakpoint（自动缓存还占 1 个）。
 *      把槽位花在注定缓存不了的前缀上，等于既没缓存、又挤掉了更大的候选。
 *   2. 「刚过线但很边缘」的前缀才真正涉及 1.25x 写入 vs 0.1x 读取的权衡；
 *      ai-agent-book ch2 点的「对缓存友好不等于零成本」说的是这一段。
 *
 * 判据用 token 估算而非字符数：一刀切字符数会在中英文之间偏得很厉害
 * （英文约 4 char/token，CJK 约 1 char/token，差 4 倍）。
 *
 * 覆盖方式：promptCache.minBreakpointTokens；显式设 0 = 不设门槛（保留旧行为，
 * 便于做对照实验）。不设该项时按模型自动分档。
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

function estimateTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  const cjk = (s.match(CJK_RE) || []).length;
  const other = Math.max(0, s.length - cjk);
  // CJK 约 1 token/字；其余按 4 char/token。宁可略高估 token（→ 更早过线），
  // 因为「漏标一个本可缓存的前缀」损失的是 0.1x 的读取优惠（真金白银），
  // 而「多标一个 sub-minimum 断点」只是浪费一个槽位、不产生费用。
  return Math.ceil(cjk + other / 4);
}

/**
 * 各模型的最小可缓存 token 数，按 Bedrock 官方模型卡（2026-08-11 核对）。
 *
 * 为什么不用正则猜：初版判据是 `/opus|haiku/ → 4096, else → 1024`，把
 * **Sonnet 4.5 漏成了 1024 档**——而官方模型卡上 Sonnet 4.5 是 4096，只有
 * Sonnet 4.6 才是 1024。同一个"Sonnet"家族里两个相邻版本分属不同档，
 * 正则按家族名分档必然出错。
 *
 * 官方值（Minimum number of tokens per cache checkpoint）：
 *     Claude Sonnet 4.5    4,096
 *     Claude Sonnet 4.6    1,024
 *     Claude Opus 4.5      4,096
 *     Claude Opus 4.6      4,096
 *     Claude Haiku 4.5     4,096
 *     Claude 3.7 Sonnet    1,024
 *     Claude Haiku 3/3.5   2,048
 *
 * 这是「手写清单必漂」的解法：判据落到**显式表**，未知模型取保守档，
 * 新模型上线时只会偏保守（少标一个断点），不会谎称已缓存。
 * 参考：~/agent-memory/10_knowledge/evidence-hygiene-three-failure-shapes.md 形状二
 */
const MIN_CACHEABLE_TOKENS = [
  // 顺序敏感：先匹配更具体的版本号，避免被家族名泛匹配。
  //
  // 模型名有两种版本号位置，两种都要覆盖：
  //   版本在后："claude-sonnet-4-6"、"claude-opus-4-5"
  //   版本在前："claude-3-7-sonnet-20250219"、"claude-3-5-haiku-20241022"
  // 只写一种会让另一种落到家族兜底档——实测 claude-3-5-haiku 本该 2048，
  // 因 /haiku[-_.]?3/ 匹配不到（3 在 haiku 前面）而被 /haiku/ 兜底成 4096。
  [/claude[-_.]?3[-_.]?7[-_.]?sonnet|sonnet[-_.]?3[-_.]?7/, 1024],
  [/claude[-_.]?3[-_.]?5[-_.]?haiku|haiku[-_.]?3[-_.]?5/, 2048],
  [/sonnet[-_.]?4[-_.]?6/, 1024],
  [/sonnet[-_.]?4[-_.]?5/, 4096],
  [/opus[-_.]?4[-_.]?[56]/, 4096],
  [/haiku[-_.]?4[-_.]?5/, 4096],
  // 家族兜底：未标版本的一律取该家族里**最严**的一档
  [/opus/, 4096],
  [/haiku/, 4096],
  [/sonnet/, 4096],
];

// 未知模型的保守默认。取 4096 而非 1024：
// 高估门槛 → 少标一个断点（损失 0.1x 读取优惠）；
// 低估门槛 → 标了个静默不缓存的断点，既没缓存又占掉 4 个槽位之一。
// 后者更糟，因为它同时浪费槽位和制造"已缓存"的假象。
const DEFAULT_MIN_CACHEABLE_TOKENS = 4096;

// OpenAI 隐式/显式缓存的下限是 1024，与 Anthropic 分档无关，单独判。
const OPENAI_MIN_CACHEABLE_TOKENS = 1024;

function minCacheableTokens(model) {
  const m = String(model || "").toLowerCase();
  // OpenAI 系（gpt-*、o1/o3/o4 推理系列）走自己的下限
  if (/\bgpt[-_.]?\d|\bo[134][-_.]?(?:mini|preview|pro)?\b/.test(m)) {
    return OPENAI_MIN_CACHEABLE_TOKENS;
  }
  for (const [pattern, minimum] of MIN_CACHEABLE_TOKENS) {
    if (pattern.test(m)) return minimum;
  }
  return DEFAULT_MIN_CACHEABLE_TOKENS;
}

function itemTokens(item) {
  if (!item || typeof item !== "object") return 0;
  const text = itemText(item);
  if (text) return estimateTokens(text);
  // 无文本块（纯图片/文件）时按序列化体积粗估，避免整条被算成 0 而永远够不到门槛
  try {
    return estimateTokens(JSON.stringify(item));
  } catch (_) {
    return 0;
  }
}

/**
 * 稳定前缀中**位于消息数组之外**的部分的 token 量。
 *
 * 为什么必须单独算：provider 计算「可缓存前缀长度」是按整个请求前缀算的，
 * 而请求前缀 = system + tools (+ instructions) + messages[0..N]。其中
 *   Anthropic         system、tools 是独立字段
 *   openai-responses  instructions、tools 是独立字段
 *   openai-chat       system 在 messages 里，但 tools 仍是独立字段
 * 只累加消息数组会**系统性低估**前缀规模——而 tools 定义往往就有几百到几千
 * token（Anthropic 明确建议把 tools 纳入缓存正是因为这个量级）。低估的后果是
 * 门槛拒掉本来完全可缓存的 breakpoint，白白丢掉 0.1x 读取优惠。
 */
function basePrefixTokens(body, protocol) {
  let total = 0;
  if (protocol === "anthropic") {
    for (const block of body.system || []) total += itemTokens(block);
  } else if (protocol === "openai-responses") {
    total += estimateTokens(
      typeof body.instructions === "string"
        ? body.instructions
        : contentText(body.instructions),
    );
  }
  for (const tool of body.tools || []) {
    try {
      total += estimateTokens(JSON.stringify(tool));
    } catch (_) {
      /* 单个工具序列化失败不该拖垮整个估算 */
    }
  }
  return total;
}

/**
 * 过滤掉「所保护的前缀达不到最小可缓存长度」的候选。
 *
 * 判据是**累计前缀规模**而非单条消息大小：index 处的 breakpoint 保护的是
 * [0..index] 整段，所以哪怕该条消息本身很短，只要它前面已堆够内容，这个
 * breakpoint 依然有效。baseTokens 是消息数组之外的前缀量（见 basePrefixTokens）。
 */
function filterByMinTokens(items, indices, minTokens, baseTokens) {
  if (!minTokens || minTokens <= 0) return indices;
  const kept = [];
  let cumulative = Number(baseTokens) || 0;
  let cursor = 0;
  for (const index of indices) {
    while (cursor <= index && cursor < items.length) {
      cumulative += itemTokens(items[cursor]);
      cursor++;
    }
    if (cumulative >= minTokens) kept.push(index);
  }
  return kept;
}

function ensureBlocks(message, kind) {
  if (!message || typeof message !== "object") return [];
  if (Array.isArray(message.content)) return message.content;
  if (typeof message.content !== "string" || !message.content) return [];
  const type = kind === "responses" ? "input_text" : "text";
  message.content = [{ type, text: message.content }];
  return message.content;
}

function stripBlockField(blocks, field) {
  for (const block of blocks || []) {
    if (block && typeof block === "object") delete block[field];
  }
}

function markLastBlock(blocks, types, field, value) {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (!block || typeof block !== "object" || !types.has(block.type)) continue;
    if ((block.type === "text" || block.type === "input_text") && !block.text) continue;
    block[field] = clone(value);
    return true;
  }
  return false;
}

function cacheControl(ttl) {
  return ttl === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

function explicitBreakpoint() {
  return { mode: "explicit" };
}

function isGpt56(model) {
  return /(?:^|[\/])gpt[-_.]?5[.-]?6(?:$|[-_.])/i.test(String(model || ""));
}

function stableRequestBody(body, protocol, markedIndices) {
  if (!markedIndices.length) return null;
  const longest = markedIndices.length ? Math.max(...markedIndices) : -1;
  const stable = clone(body);
  if (protocol === "anthropic") {
    stable.messages = (stable.messages || []).slice(0, longest + 1);
  } else if (protocol === "openai-responses") {
    stable.input = (stable.input || []).slice(0, longest + 1);
  } else {
    stable.messages = (stable.messages || []).slice(0, longest + 1);
  }
  return stable;
}

function implicitStableIndices(items) {
  if (!Array.isArray(items) || !items.length) return [];
  const firstVolatile = items.findIndex(isVolatile);
  const lastStable = firstVolatile >= 0 ? firstVolatile - 1 : items.length - 1;
  return lastStable >= 0 ? [lastStable] : [];
}

function stableItemHashes(body, protocol, markedIndices) {
  if (!markedIndices.length) return [];
  const longest = Math.max(...markedIndices);
  const items = protocol === "openai-responses" ? body.input : body.messages;
  return (Array.isArray(items) ? items : [])
    .slice(0, longest + 1)
    .slice(-256)
    .map((item) => hash(withoutCacheAnnotations(item)));
}

/**
 * 剥掉**本模块自己打上去的**缓存注解，再参与任何身份/指纹计算。
 *
 * 2026-08-11 实测踩坑：把 cacheTtl 从 cacheFamilyHash 的入参里摘掉之后，
 * 家族哈希**依然**随 TTL 配置变化。根因是这些哈希算的是「已装饰完的 body」，
 * 而装饰过程刚好往 system/tools 上写了 `cache_control: {ttl:"1h"}`——
 * TTL 从我们自己打的标记里绕回来了。
 *
 * 这是「身份被自己的注解污染」这一形状：指纹本该只反映**内容**，
 * 而 cache_control / prompt_cache_breakpoint 是策略产物，不是内容。
 * 不剥的后果：改一次 TTL 配置就被读成「换了缓存家族」+「前缀在抖动」，
 * 归因直接指向错误方向。
 */
const CACHE_ANNOTATION_KEYS = ["cache_control", "prompt_cache_breakpoint"];

function withoutCacheAnnotations(value) {
  if (Array.isArray(value)) return value.map(withoutCacheAnnotations);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (CACHE_ANNOTATION_KEYS.includes(key)) continue;
    out[key] = withoutCacheAnnotations(child);
  }
  return out;
}

// 剥净整个请求体上的缓存标注 (block 级 cache_control/prompt_cache_breakpoint +
//   顶层 prompt_cache_options/prompt_cache_key)。返回新对象, 不改输入。
//   用于缓存关闭/降级/decorate 异常时: 适配器可能已无条件钉了断点 (常落易变末条),
//   若原样送出会每轮 1.25x 写缓存且几乎不命中。
function stripCacheAnnotations(body) {
  const out = withoutCacheAnnotations(body);
  if (out && typeof out === "object") {
    delete out.prompt_cache_options;
    delete out.prompt_cache_key;
  }
  return out;
}

/**
 * 缓存家族身份：同一份 system + tools + 模型 + 协议 == 同一个家族。
 *
 * cacheTtl **不参与**身份计算（2026-08-11 修）。TTL 是策略，不是内容身份；
 * 把它混进来会导致「仅仅把 anthropicTtl 从 5m 调成 1h」就被算成另一个家族，
 * 于是历史样本无法跨配置对比——而跨配置对比恰恰是回答「调 TTL 到底有没有用」
 * 的唯一手段。TTL 已作为并列维度记在 diagnostics.cacheTtl 里。
 */
function cacheFamilyHash(body, protocol, model) {
  const clean = withoutCacheAnnotations;
  const family = {
    protocol,
    model,
    system: clean(protocol === "anthropic"
      ? body.system || []
      : (body.messages || []).filter((item) => item && item.role === "system")),
    instructions: protocol === "openai-responses" ? clean(body.instructions || null) : null,
    tools: clean(body.tools || []),
  };
  return hash(family);
}

/**
 * system + tools 的指纹，**不依赖 breakpoint 选择**。
 *
 * 为什么必须和 stablePrefixHash 并存：stablePrefixHash 是「按我们自己选出的
 * breakpoint 位置切出稳定段」再哈希，所以它变了有两种完全不同的原因——
 *   (a) 上游真的改了 system/tools（真前缀抖动，该去查调用方）
 *   (b) 我们的 breakpoint 选择把易变内容误划进了稳定段（本模块自己的 bug）
 * 只有一个哈希时这两者无法分离，归因会指向错误的方向，而
 * 「报错方向反了，比报不出来更糟」
 * （~/agent-memory/10_knowledge/evidence-hygiene-three-failure-shapes.md 形状三）。
 *
 * 判读方式：systemToolsHash 不变而 stablePrefixHash 变 → 嫌疑在 (b)。
 */
function systemToolsHash(body, protocol) {
  const clean = withoutCacheAnnotations;
  const prefix = {
    system: clean(protocol === "anthropic"
      ? body.system || []
      : (body.messages || []).filter((item) => item && item.role === "system")),
    instructions: protocol === "openai-responses" ? clean(body.instructions || null) : null,
    tools: clean(body.tools || []),
  };
  return hash(prefix);
}

function stableDiagnostics(body, protocol, markedIndices, base) {
  const stable = withoutCacheAnnotations(stableRequestBody(body, protocol, markedIndices) || {});
  const serialized = JSON.stringify(stable);
  const itemHashes = stableItemHashes(body, protocol, markedIndices);
  return {
    cacheMode: base.cacheMode,
    cacheTtl: base.cacheTtl,
    cacheFamilyHash: cacheFamilyHash(body, protocol, base.model),
    breakpointCount: base.breakpointCount,
    stablePrefixHash: hash(serialized),
    stablePrefixChars: serialized.length,
    // CJK 感知的 token 估算 (chars/4 会把中文低估约 4 倍 · warmup 门槛判据用)
    stablePrefixTokens: estimateTokens(serialized),
    stableMessageCount: itemHashes.length,
    stableItemHashes: itemHashes,
    // 归因对照量：不依赖 breakpoint 选择，用来分离「上游改了前缀」与
    // 「我们自己划错了稳定段」。详见 systemToolsHash 的注释。
    systemToolsHash: systemToolsHash(body, protocol),
    volatileSuffixCount: base.volatileSuffixCount,
    cacheDowngrade: base.cacheDowngrade || null,
    warmup: false,
  };
}

function emptyDiagnostics(plan) {
  return {
    cacheMode: "off",
    cacheTtl: null,
    breakpointCount: 0,
    stablePrefixHash: hash(""),
    stablePrefixChars: 0,
    stablePrefixTokens: 0,
    systemToolsHash: hash(""),
    volatileSuffixCount: 0,
    cacheDowngrade:
      plan && plan.settings && plan.settings.enabled === false ? "disabled" : null,
    warmup: false,
  };
}

function decorateAnthropic(inputBody, plan) {
  const body = clone(inputBody);
  const capability = plan.capability || {};
  const canUseBreakpoints = capability.anthropicBreakpoints !== false;
  const requestedHour = plan.settings.anthropicTtl === "1h";
  const effectiveTtl = requestedHour && capability.anthropicHour !== false ? "1h" : "5m";
  const downgrade = requestedHour && effectiveTtl !== "1h" ? "anthropic-1h" :
    !canUseBreakpoints ? "anthropic-breakpoints" : null;

  if (typeof body.system === "string" && body.system) {
    body.system = [{ type: "text", text: body.system }];
  }
  if (!Array.isArray(body.system)) body.system = [];
  if (!Array.isArray(body.tools)) body.tools = body.tools ? [body.tools] : [];
  if (!Array.isArray(body.messages)) body.messages = [];

  for (const block of body.system) {
    if (block && typeof block === "object") delete block.cache_control;
  }
  for (const tool of body.tools) {
    if (tool && typeof tool === "object") delete tool.cache_control;
  }
  for (const message of body.messages) {
    stripBlockField(ensureBlocks(message, "anthropic"), "cache_control");
  }

  let breakpointCount = 0;
  const markedIndices = [];
  if (canUseBreakpoints) {
    const minTokens = plan.settings.minBreakpointTokens !== null
      ? plan.settings.minBreakpointTokens
      : minCacheableTokens(plan.model);

    // system / tools 的 breakpoint 同样受最小可缓存长度约束。
    //
    // 原实现无条件打标，于是「system 1 token + tools 3 token」也会各占一个
    // 槽位——这两个断点必然静默不缓存（provider 侧行为），却挤掉了 4 槽预算里
    // 的 2 个，让后面真正够大的消息级前缀反而没槽位可用。消息级早已做了门槛
    // 过滤，这里不做就是判据不一致。
    //
    // 累计口径遵循 Anthropic 的缓存层级 tools → system → messages：
    //   tools 断点  保护 tools 段
    //   system 断点 保护 tools + system 段
    // 所以 system 的判据用累计值，不是它自己的大小。
    let toolsTokens = 0;
    for (const tool of body.tools) {
      try {
        toolsTokens += estimateTokens(JSON.stringify(tool));
      } catch (_) {
        /* 单个工具序列化失败不该拖垮整个估算 */
      }
    }
    let systemTokens = 0;
    for (const block of body.system) systemTokens += itemTokens(block);

    if (body.tools.length && toolsTokens >= minTokens) {
      body.tools[body.tools.length - 1].cache_control = cacheControl(effectiveTtl);
      breakpointCount++;
    }
    if (
      toolsTokens + systemTokens >= minTokens &&
      markLastBlock(body.system, ANTHROPIC_CACHEABLE_TYPES, "cache_control", cacheControl(effectiveTtl))
    ) {
      breakpointCount++;
    }
    const slots = Math.max(0, 4 - breakpointCount);
    const candidates = limitCandidates(
      filterByMinTokens(
        body.messages,
        candidateIndices(
          body.messages,
          (message) => !isVolatile(message) && ensureBlocks(message, "anthropic").some(
            (block) => block && ANTHROPIC_CACHEABLE_TYPES.has(block.type),
          ),
        ),
        minTokens,
        basePrefixTokens(body, "anthropic"),
      ),
      slots,
    );
    for (const index of candidates) {
      if (markLastBlock(
        ensureBlocks(body.messages[index], "anthropic"),
        ANTHROPIC_CACHEABLE_TYPES,
        "cache_control",
        cacheControl(effectiveTtl),
      )) {
        breakpointCount++;
        markedIndices.push(index);
      }
    }
  }
  return {
    body,
    diagnostics: stableDiagnostics(body, "anthropic", markedIndices, {
      model: plan.model,
      cacheMode: canUseBreakpoints ? "explicit" : "off",
      cacheTtl: canUseBreakpoints ? effectiveTtl : null,
      breakpointCount,
      volatileSuffixCount: body.messages.filter(isVolatile).length,
      cacheDowngrade: downgrade,
    }),
    warmupSnapshot:
      plan.settings.warmup.enabled === true
        ? stableRequestBody(body, "anthropic", markedIndices)
        : null,
  };
}

function decorateOpenAI(inputBody, plan, protocol) {
  const body = clone(inputBody);
  const collectionName = protocol === "openai-responses" ? "input" : "messages";
  const kind = protocol === "openai-responses" ? "responses" : "chat";
  const items = Array.isArray(body[collectionName]) ? body[collectionName] : [];
  body[collectionName] = items;
  if (plan.sessionKey) body.prompt_cache_key = plan.sessionKey;
  if (plan.settings.legacyRetention && !isGpt56(plan.model)) {
    body.prompt_cache_retention = plan.settings.legacyRetention;
  } else {
    delete body.prompt_cache_retention;
  }

  const requestedExplicit = plan.settings.openaiMode === "explicit" && isGpt56(plan.model);
  const explicit = requestedExplicit && plan.capability.openaiExplicit !== false;
  const downgrade = requestedExplicit && !explicit
    ? "openai-explicit"
    : plan.settings.openaiTtlDowngrade
      ? "openai-ttl"
      : null;
  let breakpointCount = 0;
  const markedIndices = [];

  if (!explicit) {
    delete body.prompt_cache_options;
    const implicitIndices = implicitStableIndices(items);
    return {
      body,
      diagnostics: stableDiagnostics(body, protocol, implicitIndices, {
        model: plan.model,
        cacheMode: plan.sessionKey ? "implicit" : "off",
        cacheTtl: plan.sessionKey ? "provider" : null,
        breakpointCount: 0,
        volatileSuffixCount: items.filter(isVolatile).length,
        cacheDowngrade: downgrade,
      }),
      warmupSnapshot: null,
    };
  }

  body.prompt_cache_options = { mode: "explicit", ttl: "30m" };
  const field = "prompt_cache_breakpoint";
  const types = kind === "responses"
    ? OPENAI_RESPONSES_CACHEABLE_TYPES
    : OPENAI_CHAT_CACHEABLE_TYPES;
  for (const item of items) stripBlockField(ensureBlocks(item, kind), field);

  if (kind === "chat") {
    const systemIndex = items.findIndex((item) => item && item.role === "system");
    if (systemIndex >= 0 && markLastBlock(
      ensureBlocks(items[systemIndex], kind),
      types,
      field,
      explicitBreakpoint(),
    )) {
      breakpointCount++;
      markedIndices.push(systemIndex);
    }
  }

  const slots = Math.max(0, 4 - breakpointCount);
  const minTokens = plan.settings.minBreakpointTokens !== null
    ? plan.settings.minBreakpointTokens
    : minCacheableTokens(plan.model);
  const candidates = limitCandidates(filterByMinTokens(
    items,
    candidateIndices(
      items,
      (item) => item && item.role !== "system" && !isVolatile(item) &&
        ensureBlocks(item, kind).some((block) => block && types.has(block.type)),
    ),
    minTokens,
    basePrefixTokens(body, protocol),
  ), slots);
  for (const index of candidates) {
    if (markLastBlock(
      ensureBlocks(items[index], kind),
      types,
      field,
      explicitBreakpoint(),
    )) {
      breakpointCount++;
      markedIndices.push(index);
    }
  }

  return {
    body,
    diagnostics: stableDiagnostics(body, protocol, markedIndices, {
      model: plan.model,
      cacheMode: "explicit",
      cacheTtl: "30m",
      breakpointCount,
      volatileSuffixCount: items.filter(isVolatile).length,
      cacheDowngrade: downgrade,
    }),
    warmupSnapshot:
      plan.settings.warmup.enabled === true
        ? stableRequestBody(body, protocol, markedIndices)
        : null,
  };
}

function createPromptCachePolicy(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const schedule = typeof deps.schedule === "function" ? deps.schedule : setTimeout;
  const cancel = typeof deps.cancel === "function" ? deps.cancel : clearTimeout;
  const sendWarmup = typeof deps.sendWarmup === "function" ? deps.sendWarmup : null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const unsupported = new Map();
  const timers = new Map();
  const warmupHistory = new Map();
  let warmupSent = 0;
  let warmupFailed = 0;
  let disposed = false;

  function plan(input = {}) {
    const providerId = String(input.providerId || "provider");
    return Object.freeze({
      providerId,
      protocol: String(input.protocol || "openai-chat"),
      model: String(input.model || ""),
      sessionKey: String(input.sessionKey || "").slice(0, 256) || null,
      settings: normalizeSettings(input.settings),
      capability: { ...(unsupported.get(providerId) || {}) },
    });
  }

  function decorate(body, planValue) {
    if (!body) {
      return { body: clone(body), diagnostics: emptyDiagnostics(planValue) };
    }
    if (!planValue || planValue.settings.enabled === false) {
      // 关闭/降级: 剥净适配器可能已钉的裸断点 (含易变末条), 不带缓存标注上送。
      return { body: stripCacheAnnotations(body), diagnostics: emptyDiagnostics(planValue) };
    }
    if (planValue.protocol === "anthropic") {
      return decorateAnthropic(body, planValue);
    }
    if (planValue.protocol === "openai-responses") {
      return decorateOpenAI(body, planValue, "openai-responses");
    }
    return decorateOpenAI(body, planValue, "openai-chat");
  }

  function observeFailure(input = {}) {
    const status = Number(input.status) || 0;
    if (status !== 400 && status !== 422) return { retry: false, feature: null };
    const body = String(input.body || "");
    const providerId = String(input.providerId || "provider");
    const prior = { ...(unsupported.get(providerId) || {}) };
    let feature = null;
    if (/prompt_cache_options|prompt_cache_breakpoint/i.test(body)) {
      prior.openaiExplicit = false;
      feature = "openai-explicit";
    } else if (/cache_control[\s\S]{0,120}ttl|ttl[\s\S]{0,120}cache_control/i.test(body)) {
      prior.anthropicHour = false;
      feature = "anthropic-1h";
    } else if (/cache_control/i.test(body)) {
      prior.anthropicBreakpoints = false;
      feature = "anthropic-breakpoints";
    }
    if (!feature) return { retry: false, feature: null };
    unsupported.set(providerId, prior);
    return { retry: true, feature };
  }

  function observeSuccess() {
    return true;
  }

  function scheduleWarmup(input = {}) {
    if (disposed || !sendWarmup || !input.plan || !input.snapshot) return false;
    const planValue = input.plan;
    const settings = planValue.settings && planValue.settings.warmup;
    if (!settings || settings.enabled !== true) return false;
    if (Number(input.stableTokens) < settings.minStableTokens) return false;
    if (!planValue.sessionKey) return false;
    const key = `${planValue.providerId}|${planValue.model}|${hash(planValue.sessionKey)}`;
    const existing = timers.get(key);
    if (existing) {
      try { cancel(existing); } catch (_) {}
    }
    const snapshot = clone(input.snapshot);
    const timer = schedule(async () => {
      timers.delete(key);
      if (disposed) return;
      const cutoff = now() - ONE_HOUR_MS;
      const history = (warmupHistory.get(key) || []).filter((value) => value > cutoff);
      if (history.length >= settings.maxPerHour) {
        warmupHistory.set(key, history);
        return;
      }
      history.push(now());
      warmupHistory.set(key, history);
      try {
        await sendWarmup(clone(snapshot));
        warmupSent++;
      } catch (error) {
        warmupFailed++;
        try { log(`[prompt-cache] warmup failed: ${String(error && error.message || "error").slice(0, 120)}`); } catch (_) {}
      }
    }, settings.afterMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    timers.set(key, timer);
    return true;
  }

  function status() {
    return {
      unsupportedProviders: [...unsupported.entries()].map(([key, value]) => ({
        providerHash: hash(key),
        ...value,
      })),
      activeWarmups: timers.size,
      warmupSent,
      warmupFailed,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const timer of timers.values()) {
      try { cancel(timer); } catch (_) {}
    }
    timers.clear();
  }

  return {
    plan,
    decorate,
    stripCacheAnnotations,
    observeFailure,
    observeSuccess,
    scheduleWarmup,
    status,
    dispose,
  };
}

module.exports = {
  createPromptCachePolicy,
  stripCacheAnnotations,
  AGENT_STATUS_MARKER,
  CHECKPOINT_MARKER,
};
