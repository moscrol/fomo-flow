"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const uiDir = path.join(__dirname, "..", "ui");
const html = fs.readFileSync(path.join(uiDir, "web-hud.html"), "utf8");
const css = fs.readFileSync(path.join(uiDir, "web-hud.css"), "utf8");
const js = fs.readFileSync(path.join(uiDir, "web-hud.js"), "utf8");

assert.match(html, /^<!doctype html>/i);
assert.match(html, /<html lang="zh-CN">/);
assert.match(html, /href="\/hud\/web-hud\.css"/);
assert.match(html, /src="\/hud\/web-hud\.js" defer/);
assert.match(html, /data-screen-label="FOMO FLOW HUD"/);
for (const id of [
  "connectionState",
  "refreshAge",
  "kpiStrip",
  "sessionList",
  "sessionDetail",
  "providerList",
  "taskList",
  "taskCount",
  "requestRows",
  "emptyState",
  "surfaceFilters",
  "detailReasoningTokens",
  "detailTtft",
  "detailDuration",
  "detailCompactions",
  "detailModelPath",
  "detailLoopSource",
  "detailProviderP50",
  "detailProviderP95",
  "detailCacheHitP95",
  "detailCacheMissP95",
]) {
  assert(html.includes(`id="${id}"`), `missing #${id}`);
}
assert.match(html, /aria-live="polite"/);
assert.match(html, /<noscript>/);
assert.doesNotMatch(
  html,
  /<script(?![^>]*\bsrc=)[^>]*>/i,
  "inline script violates CSP",
);
assert.doesNotMatch(html, /https?:\/\//i, "HUD assets must remain local");
assert.doesNotMatch(html, /<form\b/i, "v1 HUD is read-only");
assert.match(html, /data-surface-filter="all"/);
assert.match(html, /data-surface-filter="devin"/);
assert.match(html, /data-surface-filter="codex"/);
assert.match(html, /<th scope="col">来源<\/th>/);
assert.match(html, /<th scope="col">缓存 \/ 会话亲和<\/th>/);
assert.match(html, /<th scope="col">前缀连续性<\/th>/);
assert.match(html, /上游首字/);
assert.match(html, /重试开销/);

new vm.Script(js, { filename: "web-hud.js" });
assert(js.includes('new EventSource("/origin/hud/events")'));
assert(js.includes('fetch("/origin/hud/snapshot"'));
assert(js.includes("dao.webHud.selectedSession.v1"));
assert(js.includes("textContent"));
assert(js.includes("document.createElement"));
assert(js.includes("const cache = session.cache || {}"));
assert(js.includes('cache.observed ? formatPercent(cache.hitRate) : "—"'));
assert(js.includes('"暂无会话缓存样本"'));
assert(js.includes('badge("RECENT", "is-warning")'));
assert(js.includes("request.source"));
assert(js.includes("session.telemetry"));
assert(js.includes("state.surfaceFilter"));
assert(js.includes("provider.latency"));
assert(js.includes("request.upstreamSemanticMs"));
assert(js.includes("function cacheStatus(request)"));
assert(js.includes('request.cacheStatus === "hit"'));
assert(js.includes('request.cacheStatus === "miss"'));
assert(js.includes("request.usageObserved !== true"));
assert(js.includes('label: "UNKNOWN"'));
assert(js.includes('const cacheMeasured = cacheStatus(request) !== "unknown"'));
assert(js.includes('metric("近期 HIT", formatPercent(provider.recentHitRate))'));
assert(js.includes('"累计 HIT"'));
assert(js.includes('"append-only": ["仅追加", "前缀连续，可复用"]'));
assert(js.includes('rewritten: ["已重排", "上下文被重排，上游无法复用前缀"]'));
assert(js.includes('"family-changed": ["新缓存族", "缓存族刚切换，需要重新建立缓存"]'));
assert(js.includes('request && request.prefixState !== "unknown"'));
assert(js.includes('finite(request.stablePrefixChars) > 2'));
assert.doesNotMatch(js, /request\.stablePrefixHash/);
assert.doesNotMatch(js, /prompt|assistantText|toolInput|toolOutput/);
assert.doesNotMatch(js, /provider \? formatPercent\(provider\.recentHitRate\)/);
assert.doesNotMatch(js, /\.innerHTML\s*=/);
assert.doesNotMatch(js, /\beval\s*\(/);
assert.doesNotMatch(js, /document\.write\s*\(/);
assert.doesNotMatch(
  js,
  /localStorage\.setItem\([^,]+,(?!\s*state\.selectedSessionId)/,
);

assert.match(css, /--font-sans:\s*-apple-system[^;]+PingFang SC/);
assert.match(css, /@media\s*\(max-width:\s*900px\)/);
assert.match(css, /:focus-visible/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\s*\(/i);
assert.doesNotMatch(css, /@import/i, "HUD must not load external styles");
assert.match(html, /会话缓存/);
assert.match(html, /渠道缓存统计/);
assert.match(html, /长任务运行情况/);
assert.match(html, /这里只观察 Dao 登记的长任务，不是聊天会话/);
assert.match(html, /超过 5 分钟无活动即退出当前工作，历史不删除/);
assert.match(html, /数据源/);
assert(js.includes("`本机 :${finite(runtime.port) || 8955}`"));
assert.doesNotMatch(html, /任务可靠性/);
assert(js.includes("function renderTasks(snapshot)"));
assert(js.includes("fallbackCount"));
assert(js.includes("taskSummaryCounts"));
assert.doesNotMatch(js, /task\.jobId/);
assert.doesNotMatch(js, /commandSummary|stdoutSummary|stderrSummary/);

console.log("web hud client: PASS");
