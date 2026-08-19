#!/usr/bin/env node
// dao-test.js · 道Agent Pro 全链路闭环测试入口
// 道义: 四十八章「为道者日损 损之又损 以至于无为 无为而无不为」
//   损去芜杂 · 归于闭环 · 一键全链路验证
//
// 用法:
//   node dao-test.js              # 全链路 (L1 Wire + L2 路由 + L3 对话 + L4 协议 + L5 深度)
//   node dao-test.js --quick      # 快速 (L1 + L2)
//   node dao-test.js --e2e        # 含端到端 (需代理运行中)
//   node dao-test.js --protocol   # 仅协议验证
//   node dao-test.js --help

"use strict";

const path = require("path");
const fs = require("fs");

// ─── 颜色辅助 ──
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};
const ok = (s) => `${C.green}✅ ${s}${C.reset}`;
const fail = (s) => `${C.red}❌ ${s}${C.reset}`;
const info = (s) => `${C.cyan}${s}${C.reset}`;
const warn = (s) => `${C.yellow}⚠ ${s}${C.reset}`;
const header = (s) => `${C.bold}${C.magenta}${s}${C.reset}`;

// ─── 参数解析 ──
const args = process.argv.slice(2);
const optQuick = args.includes("--quick");
const optE2E = args.includes("--e2e");
const optProtocol = args.includes("--protocol");
const optHelp = args.includes("--help");

if (optHelp) {
  console.log(`
${header("道Agent Pro · 全链路闭环测试")}
${info("用法:")} node dao-test.js [选项]

  (无参数)     全链路: L1 Wire + L2 路由 + L3 对话 + L4 协议 + L5 深度
  --quick      快速: L1 Wire + L2 路由 (秒级)
  --e2e        含端到端: 需代理运行中 (http://127.0.0.1:8981)
  --protocol   仅协议验证: protobuf/Connect-RPC/SSE
  --help       此帮助

${info("测试层级:")}
  L1 Wire自检     protobuf编解码 · Connect-RPC帧格式
  L2 单场景路由    11个场景 · 工具调用 · 参数schema
  L3 完整对话流    工具调用→结果→继续
  L4 协议适配器    Anthropic/OpenAI Chat/OpenAI Responses
  L5 深度验证      277项 · isCustomToolCall · 白名单 · 别名 · 生命周期
  L6 端到端       直连代理 · DeepSeek API · 全链路往返
`);
  process.exit(0);
}

// ─── 统计 ──
let totalPass = 0;
let totalFail = 0;
let totalSkip = 0;

// ─── L1-L5: 运行LSP模拟器 ──
async function runLspSimulator() {
  console.log(header("\n═══════════════════════════════════════════"));
  console.log(header("  道 Agent Pro · LSP 全链路模拟器"));
  console.log(header("═══════════════════════════════════════════\n"));

  const simRunPath = path.join(__dirname, "lsp_sim_run.js");
  if (!fs.existsSync(simRunPath)) {
    console.log(fail("lsp_sim_run.js 不存在"));
    totalFail++;
    return false;
  }

  try {
    delete require.cache[require.resolve(simRunPath)];
    const simRun = require(simRunPath);

    if (typeof simRun.run === "function") {
      const result = await simRun.run();
      if (result) {
        totalPass += result.pass || 0;
        totalFail += result.fail || 0;
      }
      return true;
    } else {
      console.log(fail("lsp_sim_run.js 未导出 run()"));
      totalFail++;
      return false;
    }
  } catch (e) {
    console.log(fail(`LSP模拟器执行失败: ${e.message}`));
    totalFail++;
    return false;
  }
}

// ─── L6: 端到端验证 ──
async function runE2E() {
  console.log(header("\n═══════════════════════════════════════════"));
  console.log(header("  L6 · 端到端验证 (代理 → DeepSeek)"));
  console.log(header("═══════════════════════════════════════════\n"));

  const http = require("http");

  // 1. 检查代理状态
  const checkProxy = () =>
    new Promise((resolve) => {
      const req = http.get("http://127.0.0.1:8981/origin/ea/status", (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(d);
            resolve({
              ok: j.ok,
              ready: j.ready,
              uids: Object.keys(j.uids || {}),
            });
          } catch {
            resolve({ ok: false });
          }
        });
      });
      req.on("error", () => resolve({ ok: false }));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve({ ok: false });
      });
    });

  const status = await checkProxy();
  if (!status.ok) {
    console.log(warn("代理未运行 (http://127.0.0.1:8981) — 跳过E2E"));
    totalSkip++;
    return;
  }
  console.log(
    ok(
      `代理状态: ok=${status.ok} ready=${status.ready} routes=${status.uids.join(",")}`,
    ),
  );

  // 2. 检查DeepSeek直连
  const https = require("https");
  const testDeepSeek = () =>
    new Promise((resolve) => {
      const body = JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "say ok" }],
        max_tokens: 10,
        stream: false,
      });
      const req = https.request(
        {
          hostname: "api.deepseek.com",
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            try {
              const j = JSON.parse(d);
              resolve({
                ok: !!j.choices,
                model: j.model,
                content: j.choices?.[0]?.message?.content,
              });
            } catch {
              resolve({ ok: false });
            }
          });
        },
      );
      req.on("error", (e) => resolve({ ok: false, err: e.message }));
      req.write(body);
      req.end();
    });

  const ds = await testDeepSeek();
  if (ds.ok) {
    console.log(ok(`DeepSeek直连: model=${ds.model} content="${ds.content}"`));
    totalPass += 2;
  } else {
    console.log(fail(`DeepSeek直连失败: ${ds.err || "未知"}`));
    totalFail += 2;
  }

  // 3. 检查路由配置
  const checkRoutes = () =>
    new Promise((resolve) => {
      const req = http.get("http://127.0.0.1:8981/origin/ea/routes", (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(d);
            resolve({ ok: j.ok, routes: Object.keys(j.routes || {}) });
          } catch {
            resolve({ ok: false });
          }
        });
      });
      req.on("error", () => resolve({ ok: false }));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve({ ok: false });
      });
    });

  const routes = await checkRoutes();
  if (routes.ok) {
    console.log(
      ok(`路由配置: ${routes.routes.length}条 (${routes.routes.join(", ")})`),
    );
    totalPass++;
  } else {
    console.log(fail("路由配置获取失败"));
    totalFail++;
  }

  // 4. 检查诊断日志最近成功路由
  const diagPath = path.join(
    __dirname,
    "..",
    "bundled-origin",
    "_router_diag.log",
  );
  if (fs.existsSync(diagPath)) {
    const tail = fs
      .readFileSync(diagPath, "utf8")
      .split("\n")
      .slice(-50)
      .filter((l) => l.includes("_tryRoute  SUCCESS"))
      .pop();
    if (tail) {
      console.log(ok(`最近成功路由: ${tail.trim().slice(-80)}`));
      totalPass++;
    } else {
      console.log(warn("诊断日志无最近成功路由记录"));
      totalSkip++;
    }
  }
}

// ─── 协议验证 ──
async function runProtocolCheck() {
  console.log(header("\n═══════════════════════════════════════════"));
  console.log(header("  协议验证 · protobuf / Connect-RPC / SSE"));
  console.log(header("═══════════════════════════════════════════\n"));

  const checks = [];

  // 1. cascade_wire.js 存在且可加载
  const wirePath = path.join(__dirname, "cascade_wire.js");
  if (fs.existsSync(wirePath)) {
    try {
      delete require.cache[require.resolve(wirePath)];
      const wire = require(wirePath);
      const hasEncode = typeof wire.encodeString === "function";
      const hasBuild = typeof wire.buildFrame === "function";
      const hasParse = typeof wire.parseFrames === "function";
      checks.push({
        name: "cascade_wire.js 编解码",
        pass: hasEncode && hasBuild && hasParse,
      });
    } catch (e) {
      checks.push({
        name: "cascade_wire.js 加载",
        pass: false,
        err: e.message,
      });
    }
  } else {
    checks.push({ name: "cascade_wire.js 存在", pass: false });
  }

  // 2. dao_router.js 存在且含关键函数
  const routerPath = path.join(__dirname, "dao_router.js");
  if (fs.existsSync(routerPath)) {
    const src = fs.readFileSync(routerPath, "utf8");
    checks.push({
      name: "dao_router.js _streamOaToCascade 三协议",
      pass:
        src.includes("_isAnthropic") &&
        src.includes("_isResponses") &&
        src.includes("_chatAdapter"),
    });
    checks.push({
      name: "dao_router.js _sseEventType 追踪",
      pass: src.includes("_sseEventType"),
    });
    checks.push({
      name: "dao_router.js _KNOWN_TOOL_NAMES 含LSP别名",
      pass:
        src.includes("Read") &&
        src.includes("Grep") &&
        src.includes("CodeSearch"),
    });
    checks.push({
      name: "dao_router.js _STUB_MODELS 已清空",
      pass: src.includes("new Set([])") || src.includes("new Set([") === false,
    });
    checks.push({
      name: "dao_router.js isCustomToolCall 修正",
      pass:
        src.includes("_lspToolNames") && src.includes("_lspCapableToolNames"),
    });
  } else {
    checks.push({ name: "dao_router.js 存在", pass: false });
  }

  // 3. adapters.js 三协议适配器
  const adaptersPath = path.join(__dirname, "adapters.js");
  if (fs.existsSync(adaptersPath)) {
    const src = fs.readFileSync(adaptersPath, "utf8");
    checks.push({
      name: "adapters.js Anthropic SSE",
      pass: src.includes("anthropic") && src.includes("parseSSELine"),
    });
    checks.push({
      name: "adapters.js OpenAI Chat SSE",
      pass: src.includes("openai-chat") || src.includes("openaiChat"),
    });
    checks.push({
      name: "adapters.js OpenAI Responses SSE",
      pass: src.includes("openai-responses") || src.includes("openaiResponses"),
    });
  }

  // 4. sp_invert.js 工具别名
  const spInvPath = path.join(__dirname, "sp_invert.js");
  if (fs.existsSync(spInvPath)) {
    const src = fs.readFileSync(spInvPath, "utf8");
    checks.push({
      name: "sp_invert.js TOOL_ALIAS_TO_STANDARD",
      pass:
        src.includes("TOOL_ALIAS_TO_STANDARD") || src.includes("ALIAS_TO_STD"),
    });
  }

  // 5. LSP模拟器5模块完整性
  const simModules = [
    "lsp_simulator.js",
    "lsp_mock_server.js",
    "lsp_scenarios.js",
    "lsp_tools.js",
    "lsp_sim_run.js",
  ];
  for (const m of simModules) {
    const p = path.join(__dirname, m);
    checks.push({
      name: `模拟器 ${m}`,
      pass: fs.existsSync(p),
    });
  }

  for (const c of checks) {
    if (c.pass) {
      console.log(ok(c.name));
      totalPass++;
    } else {
      console.log(fail(`${c.name}${c.err ? ` (${c.err})` : ""}`));
      totalFail++;
    }
  }
}

// ─── L2.5: 档位变体路由规范化 (v9.9.279) ──
//   族连线即覆盖其全部档位变体 · swe-1-6 ⊇ swe-1-6-slow / swe-1-6-fast ...
async function runNormalizeCheck() {
  console.log(header("\n═══════════════════════════════════════════"));
  console.log(header("  L2.5 · 档位变体路由规范化 (族⊇档位)"));
  console.log(header("═══════════════════════════════════════════\n"));

  const os = require("os");
  const routerPath = path.join(__dirname, "dao_router.js");
  let router;
  try {
    delete require.cache[require.resolve(routerPath)];
    router = require(routerPath);
  } catch (e) {
    console.log(fail(`dao_router.js 加载失败: ${e.message}`));
    totalFail++;
    return;
  }

  // 临时配置: 仅连模型族 MODEL_SWE_1_6 → deepseek (不写任何档位变体 key)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-norm-"));
  const cfgPath = path.join(tmpDir, "配置.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      providers: {
        deepseek: {
          enabled: true,
          apiKey: "test-key",
          baseUrl: "https://api.deepseek.com/v1",
          models: ["deepseek-v4-flash"],
          noProviderPrefix: true,
          completionPath: "/chat/completions",
          type: "openai-compatible",
        },
      },
      daoRoutes: {
        enabled: true,
        agentStatus: { enabled: false },
        substituteEnabled: false,
        // ★ v9.9.298 起 familyTierExtend 默认关(slow 等默走官方·免费不路由)。
        //   本组专测「连族即覆盖全档」之延伸能力 → 须显式置 true 方为有效场景。
        familyTierExtend: true,
        routes: {
          MODEL_SWE_1_6: { provider: "deepseek", model: "deepseek-v4-flash" },
        },
      },
    }),
    "utf8",
  );

  try {
    router.init({ log: () => {}, configPath: cfgPath });
  } catch (e) {
    console.log(fail(`router.init 失败: ${e.message}`));
    totalFail++;
    return;
  }

  // 应路由 (族基名已连线 → 档位变体皆覆盖)
  const shouldTrue = [
    "MODEL_SWE_1_6",
    "swe-1-6",
    "swe-1-6-slow",
    "swe-1-6-fast",
    "MODEL_SWE_1_6_SLOW",
    "MODEL_SWE_1_6_FAST",
  ];
  // 不应路由 (无连线 · 未配通配符)
  const shouldFalse = ["claude-sonnet-4-5", "gpt-4o", "gemini-2-5-pro-slow"];

  for (const uid of shouldTrue) {
    const r = router.shouldRoute(uid);
    if (r === true) {
      console.log(ok(`shouldRoute(${uid}) = true`));
      totalPass++;
    } else {
      console.log(fail(`shouldRoute(${uid}) 期望 true 实得 ${r}`));
      totalFail++;
    }
  }
  for (const uid of shouldFalse) {
    const r = router.shouldRoute(uid);
    if (r === false) {
      console.log(ok(`shouldRoute(${uid}) = false`));
      totalPass++;
    } else {
      console.log(fail(`shouldRoute(${uid}) 期望 false 实得 ${r}`));
      totalFail++;
    }
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ─── L2.6: 基础档不被桩占据 · 免费模型并存 (v9.9.316) ──
//   修复前: init() 幂等补 MODEL_SWE_1_6 → builtin-stub(_seeded) · 桩占基础档
//     → shouldRoute(swe-1-6)=true → 官方透传被劫持 → 免费模型无法与 Proxy Pro 并存
//   修复后: 基础档不入路由表 → shouldRoute(swe-1-6)=false → 回落官方上游(免费原生)
//   关键: swe-1-6 / swe-1-6-slow 均未显式连线 → 保持官方透传(免费原生)
//   ★ v9.9.298: familyTierExtend 默关 → 未显式连线之档位变体(如 claude-...-thinking)亦保持官方透传
async function runSeededBaseCheck() {
  console.log(header("\n═══════════════════════════════════════════"));
  console.log(header("  L2.6 · 基础档守官方·免费并存 (不播桩)"));
  console.log(header("═══════════════════════════════════════════\n"));

  const os = require("os");
  const routerPath = path.join(__dirname, "dao_router.js");
  let router;
  try {
    delete require.cache[require.resolve(routerPath)];
    router = require(routerPath);
  } catch (e) {
    console.log(fail(`dao_router.js 加载失败: ${e.message}`));
    totalFail++;
    return;
  }

  // 配置: 显式连 fast + claude 族基名 · 不连 MODEL_SWE_1_6 (基础档应回落官方·不再播桩)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-seed-"));
  const cfgPath = path.join(tmpDir, "配置.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      providers: {
        deepseek: {
          enabled: true,
          apiKey: "test-key",
          baseUrl: "https://api.deepseek.com/v1",
          models: ["deepseek-v4-flash", "deepseek-v4-pro"],
          noProviderPrefix: true,
          completionPath: "/chat/completions",
          type: "openai-compatible",
        },
      },
      daoRoutes: {
        enabled: true,
        agentStatus: { enabled: false },
        substituteEnabled: false,
        routes: {
          "swe-1-6-fast": { provider: "deepseek", model: "deepseek-v4-flash" },
          "claude-sonnet-4-6": { provider: "deepseek", model: "deepseek-v4-pro" },
        },
      },
    }),
    "utf8",
  );

  try {
    router.init({ log: () => {}, configPath: cfgPath });
  } catch (e) {
    console.log(fail(`router.init 失败: ${e.message}`));
    totalFail++;
    return;
  }

  const cases = [
    ["swe-1-6", false, "基础版→官方透传(不再播种桩·免费模型并存)"],
    ["swe-1-6-fast", true, "Fast→deepseek(显式连线)"],
    ["swe-1-6-slow", false, "Slow→官方透传(未连线·播种桩不吞)"],
    ["claude-sonnet-4-6", true, "Claude族基名→deepseek(显式)"],
    // ★ v9.9.298: familyTierExtend 默认关 → 未显式连线之 Thinking 档保持官方透传(不路由)。
    ["claude-sonnet-4-6-thinking", false, "Thinking档·默认官方(未显式连线·familyTierExtend默关)"],
    ["gpt-4o", false, "未连线→不路由"],
  ];
  for (const [uid, exp, desc] of cases) {
    const r = router.shouldRoute(uid);
    if (r === exp) {
      console.log(ok(`shouldRoute(${uid}) = ${r} · ${desc}`));
      totalPass++;
    } else {
      console.log(fail(`shouldRoute(${uid}) 期望 ${exp} 实得 ${r} · ${desc}`));
      totalFail++;
    }
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// ─── L4.5: 提示缓存 (prompt caching) ──
//   Anthropic: system/末位工具/末条消息钉 cache_control 断点 + 恒发 prompt-caching beta 头
//   OpenAI/DeepSeek: cached 提取 (prompt_tokens_details / prompt_cache_hit_tokens)
//   dao_router: stream_options.include_usage + usage() 聚合 cached/hitRate
async function runCacheCheck() {
  console.log(header("\n═══════════════════════════════════════════"));
  console.log(header("  L4.5 · 提示缓存 (缓存命中率)"));
  console.log(header("═══════════════════════════════════════════\n"));

  const checks = [];
  let adapters;
  try {
    const p = path.join(__dirname, "adapters.js");
    delete require.cache[require.resolve(p)];
    adapters = require(p);
  } catch (e) {
    console.log(fail(`adapters.js 加载失败: ${e.message}`));
    totalFail++;
    return;
  }

  const anth = adapters.adapterFor("anthropic");
  const body = anth.buildRequest({
    messages: [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "world" },
    ],
    tools: [
      { function: { name: "a", description: "d", parameters: {} } },
      { function: { name: "b", description: "d", parameters: {} } },
    ],
    model: "claude-sonnet-4-5",
    maxOutputTokens: 100,
    thinkingEnabled: false,
  });

  checks.push({
    name: "Anthropic system 恒钉 cache_control (非 thinking 亦钉)",
    pass:
      Array.isArray(body.system) &&
      body.system[0] &&
      body.system[0].cache_control &&
      body.system[0].cache_control.type === "ephemeral",
  });
  checks.push({
    name: "Anthropic 末位工具钉 cache_control (工具定义可缓存)",
    pass:
      Array.isArray(body.tools) &&
      !!body.tools[body.tools.length - 1].cache_control,
  });
  const lastMsg = body.messages[body.messages.length - 1];
  const lastBlocks = Array.isArray(lastMsg.content) ? lastMsg.content : [];
  checks.push({
    name: "Anthropic 末条消息钉 cache_control (增量对话缓存)",
    pass: lastBlocks.some((b) => b && b.cache_control),
  });

  const opts = anth.buildRequestOpts(
    { apiKey: "k" },
    body,
    new URL("https://api.anthropic.com/v1/messages"),
  );
  checks.push({
    name: "Anthropic 恒发 prompt-caching beta 头",
    pass: String(opts.headers["anthropic-beta"] || "").includes(
      "prompt-caching",
    ),
  });

  // Anthropic usage: cache_read/cache_creation 提取
  const msgStart = anth.parseSSELine(
    JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 5,
        },
      },
    }),
    "message_start",
  );
  checks.push({
    name: "Anthropic usage 提取 cached+cacheWrite",
    pass:
      msgStart.usage &&
      msgStart.usage.cached === 90 &&
      msgStart.usage.cacheWrite === 5,
  });

  // OpenAI Chat usage: OpenAI 与 DeepSeek 两种字段
  const chat = adapters.adapterFor("openai-chat");
  const chatCacheBody = chat.buildRequest({
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-5.4",
    promptCacheKey: "dao:test-session",
  });
  checks.push({
    name: "OpenAI Chat 透传稳定 prompt_cache_key",
    pass: chatCacheBody.prompt_cache_key === "dao:test-session",
  });
  const responsesCacheBody = adapters.adapterFor("openai-responses").buildRequest({
    messages: [{ role: "user", content: "hello" }],
    model: "gpt-5.4",
    promptCacheKey: "dao:test-session",
  });
  checks.push({
    name: "OpenAI Responses 透传稳定 prompt_cache_key",
    pass: responsesCacheBody.prompt_cache_key === "dao:test-session",
  });
  const oaUsage = chat.parseSSELine(
    JSON.stringify({
      choices: [{ delta: {} }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
      },
    }),
  );
  const dsUsage = chat.parseSSELine(
    JSON.stringify({
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60 },
    }),
  );
  checks.push({
    name: "OpenAI Chat usage cached (prompt_tokens_details.cached_tokens)",
    pass:
      oaUsage.usage &&
      oaUsage.usage.cached === 80 &&
      oaUsage.usage.cacheWrite === 20,
  });
  const chatUnaryUsage = chat.parseUnaryResponse(JSON.stringify({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 30 },
    },
  }));
  checks.push({
    name: "OpenAI Chat unary usage cached+cacheWrite",
    pass:
      chatUnaryUsage.usage &&
      chatUnaryUsage.usage.cached === 70 &&
      chatUnaryUsage.usage.cacheWrite === 30,
  });
  const responses = adapters.adapterFor("openai-responses");
  const responsesStreamUsage = responses.parseSSELine(
    JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 200,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 160, cache_write_tokens: 40 },
        },
      },
    }),
    "response.completed",
  );
  checks.push({
    name: "OpenAI Responses stream usage cached+cacheWrite",
    pass:
      responsesStreamUsage.usage &&
      responsesStreamUsage.usage.cached === 160 &&
      responsesStreamUsage.usage.cacheWrite === 40,
  });
  const responsesUnaryUsage = responses.parseUnaryResponse(JSON.stringify({
    object: "response",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 200,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 150, cache_write_tokens: 50 },
    },
  }));
  checks.push({
    name: "OpenAI Responses unary usage cached+cacheWrite",
    pass:
      responsesUnaryUsage.usage &&
      responsesUnaryUsage.usage.cached === 150 &&
      responsesUnaryUsage.usage.cacheWrite === 50,
  });
  // ★ include_usage 末帧 choices:[] 空数组 · 不可被 skip 吞掉 (真实 OpenAI 行为)
  const tailUsage = chat.parseSSELine(
    JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } },
    }),
  );
  checks.push({
    name: "OpenAI Chat 末帧 usage (choices:[]) 不被 skip",
    pass: tailUsage.type === "delta" && tailUsage.usage && tailUsage.usage.cached === 800,
  });
  checks.push({
    name: "DeepSeek usage cached (prompt_cache_hit_tokens)",
    pass: dsUsage.usage && dsUsage.usage.cached === 60,
  });

  // dao_router 源码级验证
  const routerSrc = fs.readFileSync(path.join(__dirname, "dao_router.js"), "utf8");
  checks.push({
    name: "dao_router 流式请求 stream_options.include_usage",
    pass: routerSrc.includes("stream_options") && routerSrc.includes("include_usage"),
  });
  checks.push({
    name: "dao_router usage() 聚合 cached + hitRate",
    pass: routerSrc.includes("hitRate") && routerSrc.includes("_hitRate"),
  });

  const routerPath = path.join(__dirname, "dao_router.js");
  delete require.cache[require.resolve(routerPath)];
  const router = require(routerPath);
  const budget = require(path.join(__dirname, "budget.js"));
  const pairedHistory = [
    { role: "system", content: "system" },
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_budget",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_budget", content: "result" },
    { role: "user", content: "continue" },
  ];
  const untrimmedHistory = budget.applyHistoryBudget(
    pairedHistory,
    1000000,
    null,
  );
  checks.push({
    name: "预算充足时 assistant/tool 配对原样保留",
    pass:
      untrimmedHistory.messagesTrimmed === 0 &&
      JSON.stringify(untrimmedHistory.messages) === JSON.stringify(pairedHistory),
  });
  const orphanHistory = budget.applyHistoryBudget(
    [
      { role: "system", content: "system" },
      { role: "tool", tool_call_id: "missing", content: "orphan" },
      { role: "user", content: "continue" },
    ],
    1000000,
    null,
  );
  checks.push({
    name: "无对应 assistant 的孤立 tool 结果仍会剔除",
    pass:
      orphanHistory.messagesTrimmed === 1 &&
      orphanHistory.messages.length === 2 &&
      orphanHistory.messages.every((message) => message.role !== "tool"),
  });
  const pairTokens =
    budget.countMessageTokens(pairedHistory[2], null) +
    budget.countMessageTokens(pairedHistory[3], null);
  const tightlyTrimmedHistory = budget.applyHistoryBudget(
    pairedHistory.slice(0, 4),
    Math.max(0, pairTokens - 1),
    null,
  );
  checks.push({
    name: "预算不足时 assistant/tool 配对整体裁剪",
    pass:
      tightlyTrimmedHistory.messagesTrimmed === 3 &&
      tightlyTrimmedHistory.messages.length === 1 &&
      tightlyTrimmedHistory.messages[0].role === "system",
  });
  // ★ 回归: route() 预算裁剪结果必须写回 (曾只记 stats 未替换 messages/tools)
  const budgetRouteMessages = [
    { role: "system", content: "sys" },
    { role: "user", content: "旧长文".repeat(2000) },
    { role: "user", content: "recent" },
  ];
  const budgetRouteOutcome = router._test.applyRequestBudget({
    messages: budgetRouteMessages,
    tools: [],
    system: "sys",
    budget: { maxContextTokens: 100 },
    modelUid: "gpt-test",
  });
  checks.push({
    name: "route() 预算裁剪生效时写回裁剪后 messages",
    pass:
      budgetRouteOutcome.stats &&
      budgetRouteOutcome.stats.messagesTrimmed > 0 &&
      budgetRouteOutcome.messages.length < budgetRouteMessages.length &&
      budgetRouteOutcome.messages.some(
        (message) => message.content === "recent",
      ) &&
      budgetRouteOutcome.messages.every(
        (message) => !String(message.content || "").includes("旧长文"),
      ),
  });
  const budgetAmpleMessages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ];
  const budgetAmpleTools = [];
  const budgetAmpleOutcome = router._test.applyRequestBudget({
    messages: budgetAmpleMessages,
    tools: budgetAmpleTools,
    system: "sys",
    budget: null,
    modelUid: "gpt-test",
  });
  checks.push({
    name: "route() 预算充足时保留原引用 (缓存前缀不动)",
    pass:
      budgetAmpleOutcome.messages === budgetAmpleMessages &&
      budgetAmpleOutcome.tools === budgetAmpleTools &&
      budgetAmpleOutcome.stats &&
      budgetAmpleOutcome.stats.messagesTrimmed === 0,
  });
  for (let i = 1; i <= 6; i++) {
    router._test.recordUsage(
      "cache-window-test",
      "gpt-test",
      { input: 100, output: 1, cached: i * 10 },
      {
        source: "cascade",
        cacheKeyHash: "a1b2c3d4",
        systemHash: "syshash",
        toolsHash: "toolhash",
        messageCount: i,
        toolCount: 2,
      },
    );
  }
  const cacheWindowUsage = router.usage()["cache-window-test"];
  checks.push({
    name: "缓存观测返回最近5次命中率与脱敏指纹",
    pass:
      cacheWindowUsage.recent.calls === 5 &&
      cacheWindowUsage.recent.input === 500 &&
      cacheWindowUsage.recent.cached === 200 &&
      cacheWindowUsage.recent.hitRate === 40 &&
      cacheWindowUsage.requests.length === 6 &&
      cacheWindowUsage.requests[5].cacheKeyHash === "a1b2c3d4" &&
      !("prompt" in cacheWindowUsage.requests[5]),
  });
  router._test.recordUsage(
    "ttft-observation-test",
    "gpt-test",
    { input: 100, output: 1, cached: 50 },
    {
      source: "cascade",
      ttftMs: 321,
      ttftObserved: true,
      daoDispatchMs: 4,
      upstreamHeaderMs: 80,
      upstreamSemanticMs: 300,
      retryOverheadMs: 17,
      durationMs: 900,
      attemptCount: 2,
      firstSignalKind: "tool",
      success: true,
    },
  );
  const ttftSample = router.usage()["ttft-observation-test"].requests.at(-1);
  checks.push({
    name: "Devin TTFT观测保留分段耗时且缺失值不伪造为0",
    pass:
      ttftSample.ttftMs === 321 &&
      ttftSample.ttftObserved === true &&
      ttftSample.daoDispatchMs === 4 &&
      ttftSample.upstreamHeaderMs === 80 &&
      ttftSample.upstreamSemanticMs === 300 &&
      ttftSample.retryOverheadMs === 17 &&
      ttftSample.durationMs === 900 &&
      ttftSample.attemptCount === 2 &&
      ttftSample.firstSignalKind === "tool" &&
      cacheWindowUsage.requests[5].ttftMs === null,
  });
  const normalized = router._test.fixOAMessages(
    router._test.buildOAMessages({
      system: "system",
      messages: [
        {
          role: "assistant",
          content: "calling",
          tool_calls: [
            { id: "call_1", name: "read_file", argumentsJson: "{}" },
          ],
        },
        {
          role: "user",
          content: "read failed",
          tool_call_id: "call_1",
          tool_result_is_error: true,
        },
        { role: "user", content: "The last tool call was an error." },
      ],
    }),
  );
  const normalizedToolResult = normalized.find(
    (m) => m.role === "tool" && m.tool_call_id === "call_1",
  );
  checks.push({
    name: "Cascade role=user + tool_call_id 归一为真实 tool result",
    pass:
      !!normalizedToolResult &&
      normalizedToolResult.content === "[ERROR] read failed",
  });
  checks.push({
    name: "真实工具结果存在时不再生成占位 tool result",
    pass: !normalized.some(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        m.content.startsWith("[tool result for "),
    ),
  });
  const toolContinuation = router._test.fixOAMessages(
    router._test.buildOAMessages({
      system: "stable system",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_2", name: "read_file", argumentsJson: "{}" },
          ],
        },
        {
          role: "user",
          content: "file contents",
          tool_call_id: "call_2",
        },
      ],
    }),
  );
  const nextTurn = [
    ...toolContinuation,
    { role: "assistant", content: "done" },
  ];
  checks.push({
    name: "工具续跑以真实 tool 结果结尾且不插空 assistant",
    pass:
      toolContinuation.at(-1)?.role === "tool" &&
      toolContinuation.filter(
        (m) => m.role === "assistant" && m.content === "" && !m.tool_calls,
      ).length === 0,
  });
  checks.push({
    name: "工具成功/失败续跑保持序列化公共前缀",
    pass: toolContinuation.every(
      (message, index) =>
        JSON.stringify(message) === JSON.stringify(nextTurn[index]),
    ),
  });
  const wire = require(path.join(__dirname, "cascade_wire.js"));
  const jsonToolError = wire.parseGetChatMessageRequest(
    Buffer.from(
      JSON.stringify({
        cascadeId: "cascade-json",
        messages: [
          {
            role: "user",
            content: "failed",
            tool_call_id: "call_json",
            tool_result_is_error: true,
          },
        ],
      }),
    ),
    true,
  );
  checks.push({
    name: "JSON Cascade 工具错误标记完整保留",
    pass: jsonToolError.messages[0]?.tool_result_is_error === true,
  });
  checks.push({
    name: "缓存键仅使用稳定 cascadeId 不回退 promptId",
    pass:
      router._test.conversationPromptCacheKey({
        cascadeId: "cascade-1",
        promptId: "prompt-1",
      }) === "dao:cascade-1" &&
      router._test.conversationPromptCacheKey({ promptId: "prompt-2" }) ===
        null,
  });
  // ★ 回归: 首条 user 为多模态 array content 时会话键仍可稳定派生
  const multimodalParsed = {
    modelUid: "gpt-test",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ],
  };
  const multimodalKey =
    router._test.conversationPromptCacheKey(multimodalParsed);
  checks.push({
    name: "多模态首条 user 消息仍派生稳定会话缓存键",
    pass:
      typeof multimodalKey === "string" &&
      multimodalKey.startsWith("dao:auto:") &&
      multimodalKey ===
        router._test.conversationPromptCacheKey(multimodalParsed) &&
      multimodalKey !==
        router._test.conversationPromptCacheKey({
          modelUid: "gpt-test",
          messages: [{ role: "user", content: "不同的首条消息" }],
        }),
  });
  // ★ 出站脱敏: per-route 开启 redact 时改写命中消息 · 关闭时原样返回
  const redactTarget = {
    provider: "test",
    model: "m",
    outboundRedact: { enabled: true, mode: "redact" },
  };
  const redactMessages = [
    { role: "system", content: "helpful assistant" },
    { role: "user", content: "key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234567890 go" },
  ];
  const redacted = router._test.applyOutboundRedaction(
    redactMessages,
    redactTarget,
    {},
  );
  checks.push({
    name: "出站脱敏 redact 模式改写命中消息且系统消息保持原引用",
    pass:
      redacted[0] === redactMessages[0] &&
      redacted[1] !== redactMessages[1] &&
      !redacted[1].content.includes("sk-proj-") &&
      redactMessages[1].content.includes("sk-proj-"),
  });
  const redactOff = router._test.applyOutboundRedaction(
    redactMessages,
    { provider: "test", model: "m" },
    {},
  );
  checks.push({
    name: "出站脱敏未开启时原样返回同一数组",
    pass: redactOff === redactMessages,
  });
  let redactBlocked = false;
  try {
    router._test.applyOutboundRedaction(
      redactMessages,
      { provider: "test", model: "m", outboundRedact: { enabled: true, mode: "block" } },
      {},
    );
  } catch (e) {
    redactBlocked = e && e.code === "OUTBOUND_REDACT_BLOCKED";
  }
  checks.push({
    name: "出站脱敏 block 模式命中即抛错拒绝",
    pass: redactBlocked,
  });
  // ★ 回归: Anthropic 命中率分母 = input+cached+cacheWrite (协议感知 · 不再启发式漏计 write)
  router._test.recordUsage(
    "anthropic-denominator-test",
    "claude-test",
    { input: 1000, output: 1, cached: 800, cacheWrite: 200 },
    { source: "cascade", protocol: "anthropic" },
  );
  router._test.recordUsage(
    "openai-denominator-test",
    "gpt-test",
    { input: 1000, output: 1, cached: 800, cacheWrite: 0 },
    { source: "cascade", protocol: "openai-chat" },
  );
  const anthropicUsage = router.usage()["anthropic-denominator-test"];
  const openaiUsage = router.usage()["openai-denominator-test"];
  checks.push({
    name: "缓存命中率分母按协议分支 (Anthropic 计入 write · OpenAI 用 input)",
    pass:
      anthropicUsage.recent.hitRate === 40 &&
      anthropicUsage.recent.cacheInput === 2000 &&
      openaiUsage.recent.hitRate === 80 &&
      openaiUsage.recent.cacheInput === 1000,
  });
  checks.push({
    name: "系统提示词与工具缓存指纹确定性",
    pass:
      router._test.cacheFingerprint("stable system") ===
        router._test.cacheFingerprint("stable system") &&
      router._test.cacheFingerprint([{ name: "Read" }]) ===
        router._test.cacheFingerprint([{ name: "Read" }]),
  });
  checks.push({
    name: "OpenAI兼容 GPT 路由自动启用会话级缓存键",
    pass:
      router._test.resolvePromptCacheKey(
        { type: "openai-compatible" },
        {},
        "provider",
        "gpt-5.6-sol",
        { _promptCacheKey: "dao:cascade-1" },
      ) === "dao:cascade-1",
  });
  checks.push({
    name: "不支持 prompt_cache_key 的错误可识别并透明降级",
    pass: router._test.isPromptCacheKeyUnsupportedResponse(
      400,
      'Unknown parameter: "prompt_cache_key"',
    ),
  });

  for (const c of checks) {
    if (c.pass) {
      console.log(ok(c.name));
      totalPass++;
    } else {
      console.log(fail(c.name));
      totalFail++;
    }
  }
}

// ─── 主入口 ──
async function main() {
  const start = Date.now();
  console.log(header("╔═══════════════════════════════════════════════╗"));
  console.log(header("║  道 Agent Pro · 全链路闭环测试               ║"));
  console.log(header("║  为道者日损 · 损之又损 · 以至于无为           ║"));
  console.log(header("╚═══════════════════════════════════════════════╝"));

  if (optProtocol) {
    await runProtocolCheck();
  } else {
    // L1-L5: LSP模拟器
    await runLspSimulator();

    // L2.5: 档位变体路由规范化 (秒级 · 始终运行)
    await runNormalizeCheck();

    // L2.6: 播种桩不吞兄弟档位 · slow 守官方 (秒级 · 始终运行)
    await runSeededBaseCheck();

    // 协议验证 (非quick模式)
    if (!optQuick) {
      await runProtocolCheck();
      await runCacheCheck();
    }

    // L6: 端到端 (仅--e2e)
    if (optE2E) {
      await runE2E();
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(header("\n═══════════════════════════════════════════════"));
  console.log(
    `  ${totalPass > 0 ? ok(`通过: ${totalPass}`) : ""}  ${
      totalFail > 0 ? fail(`失败: ${totalFail}`) : ""
    }  ${totalSkip > 0 ? warn(`跳过: ${totalSkip}`) : ""}  ${info(`${elapsed}s`)}`,
  );
  console.log(header("═══════════════════════════════════════════════\n"));

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(fail(`致命错误: ${e.message}`));
  process.exit(2);
});
