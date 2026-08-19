# ACP Space Model Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Devin Space's main ACP agent and its explicitly linked summary-agent use one Dao model selection while keeping separate Spaces, including Spaces on the same workspace, isolated.

**Architecture:** Retain the existing model state file keyed by the primary `devin-cli` ACP session. When an ACP process receives its `session/new` result, resolve only an exact summary-agent relationship from Devin's local `globalStorage/state.vscdb`: `summaryState/acp/devin-cli/<primary>` contains `prefixedSessionId: acp/summary-agent/<child>`. The private bridge injects the resolved primary session ID; unlinked sessions retain their own ID and never inherit a model.

**Tech Stack:** Node.js CommonJS, `sqlite3` command-line reader, HTTP/1.1 and h2c bridge, Node built-in test runner/assert.

---

### Task 1: Add an explicit ACP session-lineage resolver

**Files:**
- Create: `acp-session-lineage.js`
- Test: `test/acp-session-lineage.test.js`

- [ ] **Step 1: Write failing lineage tests**

```js
assert.equal(
  resolveAcpModelSessionId("acp/summary-agent/atlantic-clarinet", {
    readRows: () => [{
      key: "windsurf.acp.session/summaryState/acp/devin-cli/painted-paper",
      value: JSON.stringify({ prefixedSessionId: "acp/summary-agent/atlantic-clarinet" }),
    }],
  }),
  "painted-paper",
);
assert.equal(
  resolveAcpModelSessionId("acp/summary-agent/unlinked", { readRows: () => [] }),
  "acp/summary-agent/unlinked",
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/acp-session-lineage.test.js`

Expected: failure because `acp-session-lineage.js` does not exist.

- [ ] **Step 3: Implement the smallest resolver**

```js
function resolveAcpModelSessionId(sessionId, { readRows = readSummaryStateRows } = {}) {
  const id = validSessionId(sessionId);
  if (!id) return "";
  const owners = new Set();
  for (const row of readRows()) {
    const owner = primarySessionIdFromKey(row.key);
    const child = summarySessionIdFromValue(row.value);
    if (owner && child === id) owners.add(owner);
  }
  return owners.size === 1 ? [...owners][0] : id;
}
```

`readSummaryStateRows()` invokes `sqlite3 -json <globalStorage/state.vscdb>` with a fixed query restricted to `windsurf.acp.session/summaryState/acp/devin-cli/%`. It returns `[]` for a missing database, command failure, malformed JSON, malformed rows, or ambiguous ownership.

- [ ] **Step 4: Run the lineage test to verify it passes**

Run: `node test/acp-session-lineage.test.js`

Expected: `acp session lineage selftest: PASS`.

### Task 2: Resolve the bridge identity after ACP session creation

**Files:**
- Modify: `dao-acp-stdio-proxy.js:35-75,310-333,447-456`
- Modify: `test/acp-stdio-proxy.test.js:17-136`
- Modify: `test/fixtures/acp-echo-child.js`

- [ ] **Step 1: Add a failing proxy integration case**

Create a temporary state database fixture whose `summaryState/acp/devin-cli/primary-a` has `prefixedSessionId: acp/summary-agent/summary-a`. Run the proxy with `--agent-type summarizer`, make the fixture return `acp/summary-agent/summary-a` from `session/new`, and assert the controlled h2c upstream receives `primary-a`, not `summary-a`.

- [ ] **Step 2: Run the focused proxy test to verify it fails**

Run: `node test/acp-stdio-proxy.test.js`

Expected: bridge header equals the raw summary session before the resolver is wired.

- [ ] **Step 3: Use the resolved primary key in the bridge getter**

```js
const { resolveAcpModelSessionId } = require("./acp-session-lineage");
let activeAcpSessionId = "";
let activeAcpModelSessionId = "";

function rememberStartedAcpSession(line) {
  // existing matching of session/new response
  activeAcpSessionId = sessionId;
  activeAcpModelSessionId = resolveAcpModelSessionId(sessionId);
}

sessionBridge = createAcpSessionBridge({
  upstreamUrl,
  getSessionId: () => activeAcpModelSessionId || activeAcpSessionId,
});
```

Apply the same assignment for request messages that contain a session ID. The resolver must only replace a summary session when an exact persisted relationship exists.

- [ ] **Step 4: Run the proxy test to verify it passes**

Run: `node test/acp-stdio-proxy.test.js`

Expected: all assertions pass, including the new summary-agent header assertion and existing independent bridge assertion.

### Task 3: Preserve execution routing and repair the h1 bridge port use

**Files:**
- Modify: `acp-session-bridge.js:91-99`
- Modify: `test/acp-session-bridge.test.js:126-139`
- Test: `test/model-unlock-new-schema.test.js:92-164`

- [ ] **Step 1: Extend the bridge h1 test for an upstream URL without an explicit port**

Retain existing h1/h2c header assertions and assert the h1 request configuration uses the already calculated `upstreamPort`, not the possibly empty `URL.port` field.

- [ ] **Step 2: Make the minimal h1 correction**

```js
port: upstreamPort,
```

- [ ] **Step 3: Confirm routing remains primary-key-only**

Keep `_daoAcpMountedModelUid` unchanged: it accepts only bridge-injected `x-dao-acp-session`, validates it, and reads `selection.sessions[primarySessionId]`. The summary process already supplies that primary key, so execution routing requires no alias scanning and cannot bleed across Spaces.

- [ ] **Step 4: Run focused regression checks**

Run:

```bash
node test/acp-session-lineage.test.js
node test/acp-session-bridge.test.js
node test/acp-stdio-proxy.test.js
node test/model-unlock-new-schema.test.js
node --check acp-session-lineage.js
node --check acp-session-bridge.js
node --check dao-acp-stdio-proxy.js
node --check vendor/bundled-origin/source.js
git diff --check
```

Expected: all pass with no whitespace errors.

### Task 4: Deploy and verify the installed extension

**Files:**
- Copy production files to: `/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/`

- [ ] **Step 1: Copy only changed production files**

```bash
cp acp-session-lineage.js /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/acp-session-lineage.js
cp acp-session-bridge.js /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/acp-session-bridge.js
cp dao-acp-stdio-proxy.js /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/dao-acp-stdio-proxy.js
```

- [ ] **Step 2: Compare checksums and syntax-check the deployed files**

```bash
shasum -a 256 acp-session-lineage.js /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/acp-session-lineage.js
node --check /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/acp-session-lineage.js
node --check /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/dao-acp-stdio-proxy.js
```

Expected: each source/deployed checksum pair matches and syntax checks pass.

- [ ] **Step 3: Reload and make a real request**

Reload the Devin window, select `dao-opus-5` in one Space, then run a request that invokes its summary agent. Inspect `_ea_diag.log` and require `acp-model-bridge session=<primary-session> selected=dao-opus-5`. A second Space with a different Dao selection must show its own primary session and model.
