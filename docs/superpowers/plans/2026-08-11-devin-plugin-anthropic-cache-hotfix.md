# Devin Plugin Anthropic Cache Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current Devin session reuse cccc's Anthropic prompt cache without changing its provider, model, or route priority.

**Architecture:** Apply the already-tested source fix to the two matching files inside the installed Devin extension. Preserve a recoverable copy first, restart only the Devin plugin host, then require both service health and a real `cached > 0` observation before declaring success.

**Tech Stack:** Node.js CommonJS, Devin Electron extension host, Dao Flow local HTTP runtime, jq, shell health probes.

---

## File Map

- Source reference: `vendor/外接api/core/adapters.js` — canonical Anthropic request headers.
- Source reference: `vendor/外接api/core/dao_router.js` — canonical request dispatch behavior.
- Regression test: `test/anthropic-relay-auth.test.js` — distinguishes official Anthropic auth from OpenAI-compatible Anthropic relay auth.
- Installed patch target: `/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/adapters.js`.
- Installed patch target: `/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/dao_router.js`.
- Runtime facts: `http://127.0.0.1:8955/origin/health` and `http://127.0.0.1:8955/origin/ea/usage`.

### Task 1: Prove the installed plugin is missing the fix

- [ ] **Step 1: Run the source regression test**

Run:

```bash
node test/anthropic-relay-auth.test.js
```

Expected: PASS. This proves the canonical source behavior before touching the installation.

- [ ] **Step 2: Run the installed-code assertion and verify it fails**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const base = '/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core';
const adapters = fs.readFileSync(`${base}/adapters.js`, 'utf8');
const router = fs.readFileSync(`${base}/dao_router.js`, 'utf8');
if (!adapters.includes('String(provCfg.type || "").toLowerCase() !== "anthropic"')) process.exit(1);
if (router.includes('Anthropic: 移除 Authorization Bearer')) process.exit(1);
NODE
```

Expected: exit 1 because the installed plugin still lacks the source fix.

### Task 2: Back up and patch the two installed files

- [ ] **Step 1: Create a restricted, timestamped backup directory**

Run:

```bash
backup_dir="/Users/a77/.codeium/dao-byok/backups/devin-cache-hotfix-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp '/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/adapters.js' "$backup_dir/adapters.js"
cp '/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/dao_router.js' "$backup_dir/dao_router.js"
```

Expected: both backup files exist and the directory mode is 700.

- [ ] **Step 2: Add relay-compatible Authorization in the installed Anthropic adapter**

Change the installed `adapters.js` authentication block to:

```js
if (provCfg.apiKey) {
  headers["x-api-key"] = provCfg.apiKey;
  if (String(provCfg.type || "").toLowerCase() !== "anthropic") {
    headers.Authorization = `Bearer ${provCfg.apiKey}`;
  }
} else if (provCfg.authHeader) {
```

This keeps official Anthropic providers on `x-api-key` only and gives OpenAI-compatible relays both accepted headers.

- [ ] **Step 3: Stop deleting Authorization in the installed router**

Remove only this block from the installed `dao_router.js`:

```js
// ★ Anthropic: 移除 Authorization Bearer (使用 x-api-key)
if (_protocol === "anthropic" && extraHeaders["Authorization"]) {
  delete extraHeaders["Authorization"];
}
```

- [ ] **Step 4: Run static assertions**

Run the Task 1 installed-code assertion again.

Expected: exit 0. Also run:

```bash
node --check '/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/adapters.js'
node --check '/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/dao_router.js'
```

Expected: both syntax checks pass.

### Task 3: Restart only the plugin host and verify health

- [ ] **Step 1: Record the current plugin PID and usage baseline**

Run:

```bash
old_pid=$(lsof -tiTCP:8955 -sTCP:LISTEN | head -1)
curl -fsS http://127.0.0.1:8955/origin/ea/usage | jq '.usage.cccc | {calls,recent}'
```

Expected: a non-empty PID and a JSON usage summary.

- [ ] **Step 2: Terminate the old plugin host**

Run:

```bash
kill -TERM "$old_pid"
```

Expected: Devin automatically starts a new plugin host. Do not terminate the main Devin application.

- [ ] **Step 3: Wait for the new runtime health endpoint**

Poll for up to 30 seconds:

```bash
for attempt in $(seq 1 30); do
  new_pid=$(lsof -tiTCP:8955 -sTCP:LISTEN | head -1)
  if [ -n "$new_pid" ] && [ "$new_pid" != "$old_pid" ] && curl -fsS http://127.0.0.1:8955/origin/health >/dev/null; then
    exit 0
  fi
  sleep 1
done
exit 1
```

Expected: exit 0 with a different PID.

### Task 4: Verify the current Devin session reads cache

- [ ] **Step 1: Have the user send a normal short continuation in the restored session**

Do not create a new session or modify its prompt/tools. The existing 5-minute explicit cache window is the test fixture.

- [ ] **Step 2: Inspect only safe usage facts**

Run:

```bash
curl -fsS http://127.0.0.1:8955/origin/ea/usage |
  jq '.usage.cccc | {calls,recent,last:(.requests[-5:] | map({at,cached,cacheWrite,hitRate,cacheMode,cacheTtl,cacheKeyHash,systemHash,toolsHash,cacheFamilyHash,stablePrefixHash}))}'
```

Expected: the request uses `explicit`/`5m`; at least one new row has `cached > 0`. A row with only `cacheWrite > 0` is not success.

- [ ] **Step 3: If the first post-restart request only writes, send one more short continuation within five minutes**

Expected: the next request has `cached > 0`. If it does not, collect the safe hashes and restore the backup rather than broadening the patch.

### Task 5: Close out or roll back

- [ ] **Step 1: On success, record the verification without secrets**

Record provider `cccc`, protocol `anthropic`, cache mode/TTL, cached token count, hit rate, and new plugin PID. Do not record prompt content, headers, API keys, or session IDs.

- [ ] **Step 2: On failure, restore the exact backup**

Run with the captured backup directory:

```bash
cp "$backup_dir/adapters.js" '/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/adapters.js'
cp "$backup_dir/dao_router.js" '/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/dao_router.js'
```

Then restart the plugin host again and require `/origin/health` to pass.

- [ ] **Step 3: Mark this plan's completed checkboxes and commit only the plan update**

Run:

```bash
git add docs/superpowers/plans/2026-08-11-devin-plugin-anthropic-cache-hotfix.md
git commit -m "docs: record Devin cache hotfix verification"
```

Expected: no unrelated dirty files are staged.
