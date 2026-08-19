"use strict";
/**
 * inject_detect.js · 出站 prompt 注入监测阶段 (prompt injection detection)
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 十五章「豫兮若冬涉川 犹兮若畏四邻」· 对流经之物存戒心
 *
 *   定位: ACP 出站 session/prompt 里除了用户手打的文字, 还常携带 resource
 *         块(文件内容/网页摘录/工具产物)。第三方内容可能夹带「忽略之前指令」
 *         「输出你的系统提示词」一类注入话术。中间人既然经手, 就在发往真
 *         agent 之前扫一遍, 按策略 仅记录 / 拒绝。
 *
 *   设计原则:
 *     1. 纯函数, 零依赖, 不碰 fs/网络 —— 与 outbound_redact 同构, 可复用测试。
 *     2. 只收录高置信度话术 (OWASP LLM01 风格), 宁漏勿滥: 编码 agent 的正常
 *        对话里充满 "bypass" "override" 这类词, 单词级匹配误报代价太高,
 *        默认规则全部要求完整话术结构。
 *     3. 两态动作: monitor(只报, 默认) / block(命中即拒)。不提供改写 ——
 *        启发式改写第三方内容比放行更危险, 也会破坏 prompt 缓存前缀。
 *     4. 未命中时不产生任何新对象, 调用方可保原引用转发原始字节。
 */

// ── 内置高置信度话术 (低误报) ────────────────────────────────
//   每条: { name, category, re(带 g flag), enabledByDefault }
const DEFAULT_RULES = [
  {
    // "忽略/无视之前的指令" —— 要求 动词+范围词+指令词 完整结构
    name: "instruction_override",
    category: "injection",
    re: /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any)(?:\s+of)?\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directives?|messages?)\b|(?:忽略|无视|忘记|忘掉)(?:之前|以上|先前|上面|前面|以前|上述)的?(?:所有|全部)?(?:指令|指示|提示词?|规则|要求)/gi,
    enabledByDefault: true,
  },
  {
    // 系统提示词探测/外泄 —— 要求 动词+"系统提示"结构
    name: "prompt_probe",
    category: "injection",
    re: /\b(?:reveal|show|print|repeat|output|display|leak)\s+(?:your\s+|the\s+)?(?:system|initial|hidden|original)\s+(?:prompt|message|instructions?)\b|(?:输出|打印|重复|显示|泄露|告诉我)你?的?(?:系统|初始|隐藏)(?:提示词?|指令|消息)/gi,
    enabledByDefault: true,
  },
  {
    // 角色劫持 —— 只收窄结构: "you are no longer" / "假装你没有任何限制" 类
    name: "role_hijack",
    category: "injection",
    re: /\byou\s+are\s+no\s+longer\s+(?:an?\s+)?(?:AI|assistant|bound|restricted)\b|\b(?:pretend|act\s+as\s+if)\s+you\s+have\s+no\s+(?:rules|restrictions|guidelines|limitations)\b|(?:假装|假设)你(?:没有|不受)(?:任何)?(?:规则|限制|约束)/gi,
    enabledByDefault: true,
  },
  {
    // 越狱标志词 —— 只收专有短语。不收 "do anything now" / "developer mode enabled":
    // 前者是普通英文, 后者是 IDE/Chrome 日常配置用语, 编码 agent 误报代价过高。
    name: "jailbreak_marker",
    category: "injection",
    re: /\b(?:DAN\s+mode|jailbreak\s+(?:mode|prompt))\b/gi,
    enabledByDefault: true,
  },
];

function _rulesFor(opts = {}) {
  const disabled = new Set(
    Array.isArray(opts.disableRules) ? opts.disableRules : [],
  );
  const enabled = new Set(Array.isArray(opts.enableRules) ? opts.enableRules : []);
  const base = DEFAULT_RULES.filter((rule) => {
    if (disabled.has(rule.name)) return false;
    if (enabled.has(rule.name)) return true;
    return rule.enabledByDefault;
  });
  // 用户自定义规则: { name, category?, pattern(string), flags? }
  const custom = [];
  for (const raw of Array.isArray(opts.customRules) ? opts.customRules : []) {
    if (!raw || !raw.name || !raw.pattern) continue;
    try {
      const flags = String(raw.flags || "g");
      const re = new RegExp(raw.pattern, flags.includes("g") ? flags : flags + "g");
      custom.push({ name: raw.name, category: raw.category || "custom", re });
    } catch (_) {
      // 非法正则忽略, 不因用户配置崩掉热路径
    }
  }
  return base.concat(custom);
}

/**
 * 扫描单段文本 (只检测, 永不改写)。
 * @returns {{ findings: Array<{name,category,count}> }}
 */
function scanText(text, opts = {}) {
  const findings = [];
  if (typeof text !== "string" || !text) return { findings };
  const rules = opts._rules || _rulesFor(opts);
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let count = 0;
    while (rule.re.exec(text) !== null) {
      count++;
      if (rule.re.lastIndex === 0) break; // 防零宽匹配死循环
    }
    if (count > 0) findings.push({ name: rule.name, category: rule.category, count });
  }
  return { findings };
}

/**
 * 扫描一条 ACP session/prompt 的全部内容块 (text + resource)。
 * @param {Array} blocks  msg.params.prompt
 * @returns {{ findings, blocked }}  blocked 仅在 mode==="block" 且命中时为 true
 */
function scanPromptBlocks(blocks, opts = {}) {
  const acc = [];
  const rules = _rulesFor(opts);
  const scanOpts = { _rules: rules };
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      scanText(b.text, scanOpts).findings.forEach((f) => acc.push(f));
    } else if (
      b.type === "resource" &&
      b.resource &&
      typeof b.resource.text === "string"
    ) {
      scanText(b.resource.text, scanOpts).findings.forEach((f) => acc.push(f));
    }
  }
  const findings = _mergeFindings(acc);
  return { findings, blocked: opts.mode === "block" && findings.length > 0 };
}

function _mergeFindings(findings) {
  const byName = new Map();
  for (const f of findings) {
    const prev = byName.get(f.name);
    if (prev) prev.count += f.count;
    else byName.set(f.name, { name: f.name, category: f.category, count: f.count });
  }
  return Array.from(byName.values());
}

module.exports = {
  DEFAULT_RULES,
  scanText,
  scanPromptBlocks,
};
