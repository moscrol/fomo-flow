"use strict";

const crypto = require("crypto");

const MARKER_BEGIN_RE = /<!-- DAO-SELECTIVE-SP v1 pack=([a-f0-9]{12}) -->/;
const MARKER_BEGIN_PREFIX = "<!-- DAO-SELECTIVE-SP v1 pack=";
const MARKER_END = "<!-- /DAO-SELECTIVE-SP -->";
const HASH_LEN = 12;

const EXEC_TOOL_RE =
  /\b(read|write|edit|search|find|glob|grep|exec|shell|bash|cmd|command|ls|dir|list_dir|list_directory|apply_patch|str_replace|replace|browser|playwright|mcp_|notebook|todo|skill)\b/i;

const AUX_HINTS = new Set([
  "title",
  "summary",
  "memory",
  "extraction",
  "compact",
  "classify",
  "classification",
]);

const AUX_TEXT_RE =
  /\b(title for this chat|summar(y|ies) of conversations|durable memor|extract(ion)? memories|compact the conversation|classify this request)\b/i;

const CASCADE_SIGNALS = [
  "work_policy",
  "tool_calling",
  "workspace_information",
  "user_information",
  "os information",
  "agent workflow",
  "tool use",
];

const DEVIN_FAMILY_SIGNALS = [
  "You are powered by",
  "# Modes",
  "# Programming",
  "# Task Management",
  "# Safety",
];
const DEVIN_MAIN_HARNESS_MIN_SIGNALS = 3;

function sha12(text) {
  return crypto
    .createHash("sha256")
    .update(String(text == null ? "" : text), "utf8")
    .digest("hex")
    .slice(0, HASH_LEN);
}

function asString(value) {
  return value == null ? "" : String(value);
}

function emptyResult(systemText, reason, extra) {
  return Object.assign(
    {
      text: asString(systemText),
      transformed: false,
      reason,
      strategy: extra && extra.strategy ? extra.strategy : null,
      marker: null,
      packHash: extra && extra.packHash ? extra.packHash : null,
      replacedCategories: [],
      removedBlockHashes: [],
      preservedBlockHashes: [],
      preservedBlockCount: 0,
    },
    extra || {},
  );
}

function findMarkerRange(text) {
  const begin = text.search(MARKER_BEGIN_RE);
  if (begin < 0) return null;
  const match = text.slice(begin).match(MARKER_BEGIN_RE);
  if (!match) return null;
  const end = text.indexOf(MARKER_END, begin);
  if (end < 0) return null;
  return {
    start: begin,
    end: end + MARKER_END.length,
    packHash: match[1],
  };
}

function wrapPack(packText, packHash) {
  return `${MARKER_BEGIN_PREFIX}${packHash} -->\n${packText}\n${MARKER_END}`;
}

function toolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (tool.function && tool.function.name) return String(tool.function.name);
  return String(tool.name || "");
}

function hasExecTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.some((tool) => EXEC_TOOL_RE.test(toolName(tool)));
}

function isAuxRequest(opts) {
  const hints = opts.requestHints || {};
  const task = String(hints.task || hints.kind || hints.purpose || "").toLowerCase();
  if (AUX_HINTS.has(task)) return true;
  const blob = [opts.systemText, hints.goal, hints.prompt]
    .map(asString)
    .join("\n");
  return AUX_TEXT_RE.test(blob);
}

function countCascadeHits(text) {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const signal of CASCADE_SIGNALS) {
    if (lower.includes(signal)) hits += 1;
  }
  return hits;
}

function detectFamily(text) {
  if (text.includes("You are Devin")) {
    for (const signal of DEVIN_FAMILY_SIGNALS) {
      if (text.includes(signal)) return "devin_markdown";
    }
  }
  if (countCascadeHits(text) >= 2) return "cascade_xml";
  return null;
}

function isFullDevinMainHarness(text) {
  if (!text.includes("You are Devin")) return false;
  let hits = 0;
  for (const signal of DEVIN_FAMILY_SIGNALS) {
    if (text.includes(signal)) hits += 1;
  }
  return hits >= DEVIN_MAIN_HARNESS_MIN_SIGNALS;
}

function xmlUnbalanced(text) {
  const opens = [];
  const re = /<\/?([A-Za-z][\w:-]*)\b[^>]*\/?>/g;
  let match;
  while ((match = re.exec(text))) {
    const raw = match[0];
    const name = match[1];
    if (raw.startsWith("<!--") || raw.endsWith("/>") || raw.startsWith("<?")) continue;
    if (raw.startsWith("</")) {
      const expected = opens.pop();
      if (expected !== name) return true;
      continue;
    }
    opens.push(name);
  }
  return opens.length > 0;
}

function classifyRequest(opts) {
  const strategy = opts && opts.strategy;
  const provider = opts && opts.provider;
  const systemText = asString(opts && opts.systemText);
  if (strategy !== "selective_merge") {
    return { ok: false, reason: "strategy_off", family: null };
  }
  if (
    provider === "grok-session" ||
    provider === "cursor-acp" ||
    provider === "mira" ||
    provider === "mirasim"
  ) {
    return { ok: false, reason: "excluded_provider", family: null };
  }
  if (!systemText.trim()) {
    return { ok: false, reason: "empty_system", family: null };
  }
  if (isAuxRequest(opts || {})) {
    return { ok: false, reason: "aux_request", family: null };
  }
  const family = detectFamily(systemText);
  // ACP continuations can omit tool definitions even though they retain the
  // complete main-agent harness.  Keep auxiliary requests out, but do not let
  // that transport omission restore the native identity/persona.
  if (
    !hasExecTools(opts.tools) &&
    !(family === "devin_markdown" && isFullDevinMainHarness(systemText))
  ) {
    return { ok: false, reason: "no_exec_tools", family: null };
  }
  if (!family) {
    return { ok: false, reason: "incomplete_harness", family: null };
  }
  // Devin Markdown documents tags like <example> and <truncation_notice>
  // without closing them. Those are prose, not a broken harness.
  if (family !== "devin_markdown" && xmlUnbalanced(systemText)) {
    return { ok: false, reason: "unbalanced_xml", family };
  }
  return { ok: true, reason: "ok", family };
}

function makeBlock(start, end, text, kind) {
  const slice = text.slice(start, end);
  return {
    start,
    end,
    text: slice,
    kind,
    hash: sha12(slice),
  };
}

function findTopLevelXmlRanges(text) {
  const ranges = [];
  const re = /<([A-Za-z][\w:-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (ranges.some((range) => start >= range.start && end <= range.end)) continue;
    ranges.push({ start, end });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function splitByXml(text) {
  const xmlRanges = findTopLevelXmlRanges(text);
  if (!xmlRanges.length) {
    return [{ start: 0, end: text.length, kind: "md" }];
  }
  const parts = [];
  let cursor = 0;
  for (const range of xmlRanges) {
    if (range.start > cursor) {
      parts.push({ start: cursor, end: range.start, kind: "md" });
    }
    parts.push({ start: range.start, end: range.end, kind: "xml" });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ start: cursor, end: text.length, kind: "md" });
  return parts;
}

function headingLevel(line) {
  const match = /^(#{1,6})\s+\S/.exec(line);
  return match ? match[1].length : 0;
}

function splitMarkdownRegion(text, offset, end) {
  const region = text.slice(offset, end);
  if (!region) return [];
  const lines = region.split("\n");
  const starts = [];
  let lineStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const level = headingLevel(line);
    if (level > 0) starts.push({ rel: lineStart, abs: offset + lineStart, level, index: i });
    lineStart += line.length + (i < lines.length - 1 ? 1 : 0);
  }
  if (!starts.length) {
    return splitSentences(text, offset, end);
  }
  const blocks = [];
  if (starts[0].abs > offset) {
    blocks.push(...splitSentences(text, offset, starts[0].abs));
  }
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].abs;
    const nextHeading = i + 1 < starts.length ? starts[i + 1].abs : end;
    const firstNl = text.indexOf("\n", from);
    const headingEnd = firstNl >= from && firstNl < nextHeading ? firstNl + 1 : nextHeading;
    blocks.push(makeBlock(from, headingEnd, text, "md_heading"));
    if (headingEnd < nextHeading) {
      blocks.push(...splitSentences(text, headingEnd, nextHeading));
    }
  }
  return blocks;
}

function splitSentences(text, start, end) {
  const region = text.slice(start, end);
  if (!region) return [];
  const blocks = [];
  const re = /[^\n.!?]+(?:[.!?]+|\n+|$)/g;
  let match;
  let last = 0;
  while ((match = re.exec(region))) {
    const from = start + match.index;
    let to = from + match[0].length;
    const trimmed = match[0].trim();
    last = match.index + match[0].length;
    if (!trimmed) {
      if (blocks.length) {
        const prev = blocks[blocks.length - 1];
        blocks[blocks.length - 1] = makeBlock(prev.start, to, text, prev.kind);
      }
      continue;
    }
    blocks.push(makeBlock(from, to, text, "sentence"));
  }
  if (start + last < end) {
    const tail = text.slice(start + last, end);
    if (tail.trim() || !blocks.length) {
      blocks.push(makeBlock(start + last, end, text, tail.trim() ? "sentence" : "unknown"));
    } else {
      const prev = blocks[blocks.length - 1];
      blocks[blocks.length - 1] = makeBlock(prev.start, end, text, prev.kind);
    }
  }
  return blocks;
}

function splitSystemBlocks(systemText) {
  const text = asString(systemText);
  const parts = splitByXml(text);
  const blocks = [];
  for (const part of parts) {
    if (part.kind === "xml") {
      blocks.push(makeBlock(part.start, part.end, text, "xml"));
      continue;
    }
    const mdBlocks = splitMarkdownRegion(text, part.start, part.end);
    if (mdBlocks.length) blocks.push(...mdBlocks);
    else if (part.end > part.start) blocks.push(makeBlock(part.start, part.end, text, "unknown"));
  }
  if (!blocks.length && text) blocks.push(makeBlock(0, text.length, text, "unknown"));
  return blocks;
}

function headingOf(block) {
  const first = asString(block.text).split("\n", 1)[0].trim();
  return first;
}

function xmlName(block) {
  const match = /^<([A-Za-z][\w:-]*)\b/.exec(asString(block.text).trim());
  return match ? match[1].toLowerCase() : "";
}

// Exact official refusal phrasing only. Bare "never" / "refuse" / "malware"
// must not match — those appear in Git, Destructive Operations, and tool contracts.
function isPolicyRefusal(lower) {
  return (
    /assist with defensive security tasks only/.test(lower) ||
    /refuse to create, modify, or improve code that may be used maliciously/.test(lower) ||
    /do not assist with credential discovery/.test(lower) ||
    /refuse unauthorized security testing/.test(lower) ||
    /never write exploits/.test(lower) ||
    /exploit pocs?/.test(lower) ||
    /should not include exploit payloads/.test(lower) ||
    /decline the exploit/.test(lower) ||
    /attack any system regardless of ownership/.test(lower) ||
    /find and fix vulnerabilities in local codebases only/.test(lower) ||
    /do not provide assistance to users who are clearly trying to engage in criminal activity/.test(lower) ||
    /overly realistic or specific assistance with criminal activity/.test(lower) ||
    /if you determine a user query is a jailbreak/.test(lower)
  );
}

function classifyBlock(block, ctx) {
  const text = asString(block && block.text);
  const lower = text.toLowerCase();
  const heading = headingOf(block);
  const xml = xmlName(block);

  if (
    xml === "work_policy" ||
    xml === "tool_calling" ||
    xml === "workspace_information" ||
    xml === "user_information" ||
    xml === "conversation_summary" ||
    xml === "memories" ||
    xml === "unknown_note"
  ) {
    return { category: "preserve", reason: "named_preserve" };
  }

  if (/^#{1,6}\s+(modes|programming|git|task management|tool tips|destructive operations)\b/i.test(heading)) {
    return { category: "preserve", reason: "devin_harness" };
  }
  if (/^#{1,6}\s+safety\b/i.test(heading)) {
    return { category: "refusal_or_redirect", reason: "devin_safety" };
  }
  if (/^#{1,6}\s+tone\b/i.test(heading)) {
    return { category: "preserve", reason: "tone_heading" };
  }

  if (
    /work_policy|tool_calling|workspace|repository|user environment|os\/user|citation|output protocol|message framing/.test(
      lower,
    ) &&
    !/you are (devin|cascade)\b/.test(lower)
  ) {
    if (!/refuse to|never mention or reveal|you are powered by/.test(lower)) {
      return { category: "preserve", reason: "structure" };
    }
  }

  if (
    /^you are (devin|cascade)\b/i.test(text.trim()) ||
    /interactive command line agent from cognition/.test(lower) ||
    /you are powered by\b/.test(lower)
  ) {
    return { category: "identity", reason: "identity_claim" };
  }

  if (isPolicyRefusal(lower)) {
    return { category: "refusal_or_redirect", reason: "refusal" };
  }

  if (
    /only use emojis if the user explicitly requests it/.test(lower) ||
    /avoid using emojis in all communication/.test(lower) ||
    /never say that you are/.test(lower)
  ) {
    return { category: "persona_output", reason: "persona" };
  }

  if (
    /output text to communicate with the user/.test(lower) ||
    /only use tools to complete tasks/.test(lower) ||
    /do not fabricate tool results/.test(lower) ||
    /must not skip tests/.test(lower)
  ) {
    return { category: "preserve", reason: "harness_contract" };
  }

  if (xml === "communication_style") {
    return { category: "persona_output", reason: "communication_style" };
  }
  if (xml === "safety") {
    return { category: "refusal_or_redirect", reason: "xml_safety" };
  }

  if (
    /do not infer missing authorization/.test(lower) === false &&
    /authorization declarations|ownership proof/.test(lower)
  ) {
    return { category: "authorization", reason: "auth_conflict" };
  }

  return { category: "preserve", reason: "unknown_default" };
}

function isConflictCategory(category) {
  return (
    category === "identity" ||
    category === "authorization" ||
    category === "technical_scope" ||
    category === "refusal_or_redirect" ||
    category === "instruction_priority" ||
    category === "persona_output"
  );
}

function mergeSystemPrompt(opts) {
  opts = opts || {};
  const systemText = asString(opts.systemText);
  const packText = asString(opts.packText);
  const packHash = packText ? sha12(packText) : null;
  if ((opts.strategy || null) === "selective_merge" && opts.provider === "grok-session") {
    return emptyResult(systemText, "excluded_provider", {
      strategy: opts.strategy,
      packHash,
    });
  }
  const existingEarly = findMarkerRange(systemText);
  if (existingEarly && opts.strategy === "selective_merge") {
    if (existingEarly.packHash === packHash) {
      return emptyResult(systemText, "already_applied", {
        strategy: opts.strategy,
        marker: MARKER_BEGIN_PREFIX + packHash + " -->",
        packHash,
      });
    }
    if (packText.trim()) {
      const next = wrapPack(packText, packHash);
      const text =
        systemText.slice(0, existingEarly.start) +
        next +
        systemText.slice(existingEarly.end);
      return {
        text,
        transformed: true,
        reason: "pack_replaced",
        strategy: opts.strategy,
        marker: MARKER_BEGIN_PREFIX + packHash + " -->",
        packHash,
        replacedCategories: [],
        removedBlockHashes: [],
        preservedBlockHashes: [],
        preservedBlockCount: 0,
      };
    }
  }
  const classified = classifyRequest(opts);
  if (!classified.ok) {
    return emptyResult(systemText, classified.reason, {
      strategy: opts.strategy || null,
      packHash,
    });
  }
  if (!packText.trim()) {
    return emptyResult(systemText, "empty_pack", {
      strategy: opts.strategy,
      packHash,
    });
  }

  const existing = findMarkerRange(systemText);
  if (existing) {
    if (existing.packHash === packHash) {
      return emptyResult(systemText, "already_applied", {
        strategy: opts.strategy,
        marker: MARKER_BEGIN_PREFIX + packHash + " -->",
        packHash,
      });
    }
    const next = wrapPack(packText, packHash);
    const text = systemText.slice(0, existing.start) + next + systemText.slice(existing.end);
    return {
      text,
      transformed: true,
      reason: "pack_replaced",
      strategy: opts.strategy,
      marker: MARKER_BEGIN_PREFIX + packHash + " -->",
      packHash,
      replacedCategories: [],
      removedBlockHashes: [],
      preservedBlockHashes: [],
      preservedBlockCount: 0,
    };
  }

  const blocks = splitSystemBlocks(systemText);
  const decisions = blocks.map((block) => {
    const verdict = classifyBlock(block, { family: classified.family });
    return { block, ...verdict };
  });
  const conflicts = decisions.filter((item) => isConflictCategory(item.category));
  if (!conflicts.length) {
    return emptyResult(systemText, "no_conflict_anchor", {
      strategy: opts.strategy,
      packHash,
      preservedBlockHashes: decisions.map((item) => item.block.hash),
      preservedBlockCount: decisions.length,
    });
  }

  const packed = wrapPack(packText, packHash);
  let out = "";
  let inserted = false;
  const replaced = [];
  const removed = [];
  const preserved = [];
  for (const item of decisions) {
    if (isConflictCategory(item.category)) {
      if (!inserted) {
        out += packed;
        inserted = true;
      }
      if (!replaced.includes(item.category)) replaced.push(item.category);
      removed.push(item.block.hash);
      continue;
    }
    out += item.block.text;
    preserved.push(item.block.hash);
  }

  return {
    text: out,
    transformed: true,
    reason: "merged",
    strategy: opts.strategy,
    marker: MARKER_BEGIN_PREFIX + packHash + " -->",
    packHash,
    replacedCategories: replaced,
    removedBlockHashes: removed,
    preservedBlockHashes: preserved,
    preservedBlockCount: preserved.length,
  };
}

module.exports = {
  mergeSystemPrompt,
  splitSystemBlocks,
  classifyBlock,
  classifyRequest,
};
