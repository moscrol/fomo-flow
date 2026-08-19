# Terra Probe and P0 Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SWE route guard probes honor provider completion endpoints, then prove terra probing and automatic channel fallback on the running Dao instance.

**Architecture:** Keep endpoint construction in a pure exported helper used by `probeProvider`; preserve existing response classification and desired/degraded route switching. Store the guard in the workspace source, wire it into runtime startup, then sync the tested guard to the installed extension for live acceptance.

**Tech Stack:** Node.js CommonJS, built-in `assert`, Dao HTTP control/data plane, Devin extension runtime.

---

### Task 1: Build a Red-Capable Endpoint Regression Test

**Files:**
- Create: `test/swe-route-guard.test.js`
- Exercise before source sync: `/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/swe_route_guard.js`

- [ ] **Step 1: Write the failing test**

```js
"use strict";

const assert = require("node:assert");
const path = require("node:path");

const modulePath = process.env.DAO_SWE_GUARD_MODULE ||
  path.join(__dirname, "..", "vendor", "外接api", "core", "swe_route_guard.js");
const guard = require(modulePath);

assert.strictEqual(
  guard.resolveProviderEndpoint({
    baseUrl: "https://kfcoding.codes",
    completionPath: "/v1/chat/completions",
  }, "openai-chat"),
  "https://kfcoding.codes/v1/chat/completions",
);
assert.strictEqual(
  guard.resolveProviderEndpoint({
    baseUrl: "https://example.test/v1/chat/completions",
  }, "openai-chat"),
  "https://example.test/v1/chat/completions",
);
assert.strictEqual(
  guard.resolveProviderEndpoint({ baseUrl: "https://example.test/" }, "openai-chat"),
  "https://example.test/v1/chat/completions",
);

console.log("swe route guard endpoint tests: PASS");
```

- [ ] **Step 2: Run the test against the installed old implementation**

Run:

```bash
DAO_SWE_GUARD_MODULE="$HOME/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/swe_route_guard.js" node test/swe-route-guard.test.js
```

Expected: FAIL because `resolveProviderEndpoint` is not exported by the old implementation.

### Task 2: Persist and Fix the Guard in Workspace Source

**Files:**
- Create: `vendor/外接api/core/swe_route_guard.js`
- Modify: `vendor/外接api/runtime.js:266-289`
- Test: `test/swe-route-guard.test.js`

- [ ] **Step 1: Import the current installed guard as the workspace baseline**

Copy the exact installed `swe_route_guard.js` into `vendor/外接api/core/swe_route_guard.js`; do not synthesize a second implementation.

- [ ] **Step 2: Add the pure endpoint resolver**

```js
function resolveProviderEndpoint(provider, protocol) {
  const p = provider || {};
  const base = String(p.baseUrl || "").replace(/\/+$/, "");
  if (!base) return "";

  const isAnthropic =
    protocol === "anthropic" || String(protocol || "").includes("anthropic");
  const endpointPattern = isAnthropic ? /\/v1\/messages$/ : /\/chat\/completions$/;
  if (endpointPattern.test(base)) return base;

  const configuredPath = String(p.completionPath || "").trim();
  const fallbackPath = isAnthropic ? "/v1/messages" : "/v1/chat/completions";
  const completionPath = configuredPath || fallbackPath;
  return `${base}/${completionPath.replace(/^\/+/, "")}`;
}
```

- [ ] **Step 3: Use the resolver in `probeProvider`**

Replace protocol-specific string concatenation with:

```js
const protocol = isAnthropic ? "anthropic" : "openai-chat";
const url = resolveProviderEndpoint(p, protocol);
```

Keep the existing Anthropic/OpenAI headers, request bodies, timeouts, and response classifier unchanged.

- [ ] **Step 4: Export the resolver**

```js
module.exports = {
  startSweRouteGuard,
  stopSweRouteGuard,
  onProviderRecovered,
  probeProvider,
  resolveProviderEndpoint,
  _applyTemplate,
};
```

- [ ] **Step 5: Wire the guard into source runtime startup**

After the existing wire-module load in `ensure`, start the guard without blocking router startup:

```js
try {
  const guard = require(path.join(CORE_DIR, "swe_route_guard.js"));
  const logFn = opts.log || ((msg) => {
    try { console.log(msg); } catch {}
  });
  guard.startSweRouteGuard({ log: logFn });
  _singleton._sweRouteGuard = guard;
} catch (e) {
  try {
    (opts.log || console.log)(
      `[外接api] swe-route-guard start fail: ${e && e.message}`,
    );
  } catch {}
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
node test/swe-route-guard.test.js
node --check vendor/外接api/core/swe_route_guard.js
node --check vendor/外接api/runtime.js
npm run test:quick
```

Expected: endpoint test PASS, syntax checks exit 0, existing quick suite PASS.

- [ ] **Step 7: Commit the source repair**

```bash
git add test/swe-route-guard.test.js vendor/外接api/core/swe_route_guard.js vendor/外接api/runtime.js
git commit -m "fix: honor provider endpoint in SWE guard probes"
```

### Task 3: Sync and Reload the Installed Extension

**Files:**
- Modify: `/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/swe_route_guard.js`

- [ ] **Step 1: Apply the tested resolver and call-site change to the installed guard**

The installed file must contain the same `resolveProviderEndpoint`, `probeProvider` call site, and module export as the tested workspace source.

- [ ] **Step 2: Verify source and installed guard match**

Run:

```bash
cmp vendor/外接api/core/swe_route_guard.js "$HOME/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/swe_route_guard.js"
```

Expected: exit 0.

- [ ] **Step 3: Reload the Devin window**

Use `Developer: Reload Window`, then confirm `GET /origin/health` returns `ok=true`, `status=alive`, `dao_loaded=true`, and `ea_running=true`.

### Task 4: Run Live Terra and Fallback Acceptance

**Files:**
- Runtime state only: `~/.codeium/dao-byok/swe-route-guard.json`
- Runtime configuration temporarily changed through Dao control APIs and restored before completion.

- [ ] **Step 1: Probe terra through the repaired module**

Call `probeProvider` with the live, secret-bearing config inside the local process and print only `{ok,status,reason}`.

Expected: it must not return `http-200-html-not-api`. A provider-side permission error is acceptable evidence that URL routing is fixed, but does not count as a healthy channel.

- [ ] **Step 2: Confirm periodic guard state after reload**

Read `lastProbe` from `swe-route-guard.json` after a fresh timestamp appears.

Expected: same non-HTML outcome as the direct probe; `alive=true` only if the upstream API genuinely answers with chat JSON.

- [ ] **Step 3: Exercise automatic fallback without disrupting Fast**

Create a temporary loopback provider that deterministically returns HTTP 502 and a temporary route whose channel priority is `loopback-502 → ay`. Send one non-streaming `/v1/chat/completions` request and inspect diagnostics.

Expected: first target records 502, fallback target succeeds through ay, and the client receives a valid response.

- [ ] **Step 4: Remove all temporary runtime objects**

Delete the temporary route/provider and stop the loopback server. Confirm no temporary name remains in `/origin/ea/routes`, `/origin/ea/providers`, or `配置.json`.

- [ ] **Step 5: Recheck P0 invariants**

Run:

```bash
curl -fsS http://127.0.0.1:8955/origin/health
curl -fsS http://127.0.0.1:8955/origin/ea/routes
jq '.["devin.acp.agentPreferences"]["devin-cli"].model' \
  "$HOME/Library/Application Support/Devin/User/settings.json"
```

Expected: Dao healthy, Fast runtime priority remains `glm → ay → terra → grokk`, and Local model remains `swe-1-6-fast`.
