# Dao Flow Commercial Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible, buyer-ready ZIP containing a sanitized Dao Flow VSIX, Chinese Devin Local BYOK documentation, configuration examples, and a privacy audit report.

**Architecture:** A Node.js release script creates a disposable staging tree from the current working tree using an explicit runtime allowlist, writes a sanitized extension manifest and buyer README, invokes the local `vsce` binary, then audits the embedded VSIX and ZIP before publishing under `dist/`. Buyer documentation lives in `release-assets/` so it can be reviewed and regenerated without entering the VSIX.

**Tech Stack:** Node.js 26, `@vscode/vsce` 3.9.2, built-in `fs/path/child_process/crypto`, ZIP tooling from the local system, Markdown.

---

### Task 1: Add buyer-facing release assets

**Files:**
- Create: `release-assets/README-先看这里.md`
- Create: `release-assets/使用说明书-中文.md`
- Create: `release-assets/配置示例/配置.json.example`
- Create: `release-assets/配置示例/revproxy.json.example`
- Create: `release-assets/配置示例/protocol-bridge.json.example`

- [ ] **Step 1: Write the buyer README**

Include the artifact name, installation entry point, what the buyer must prepare, and a warning that the bundle contains no provider quota or API keys. Use only generic paths such as `~/.codeium/dao-byok/` and `%USERPROFILE%\\.codeium\\dao-byok\\`.

- [ ] **Step 2: Write the Chinese manual around a first Devin Local BYOK success**

Cover installation, first launch, provider setup, model UID routing, priority fallback, health probe/circuit behavior, local reverse proxy, protocol bridge, custom models/reasoning, project prompts, Agent HUD, Codex hot route, terminal/change review, migration, troubleshooting, and security. Mark live-provider or account-dependent checks as buyer-side checks.

- [ ] **Step 3: Add credential-free examples**

Use `apiKey: ""` or `YOUR_PROVIDER_API_KEY` only in examples. Keep the current runtime schema: `providers`, `daoRoutes.routes`, `gateway`, reverse-proxy `enabled/apiKey/applyInvert/exposeLan/defaultMaxTokens/isolatePrompt/disabledModels/tiers/dualPath`, and protocol bridge fields used by the UI.

- [ ] **Step 4: Check the assets for private identifiers**

Run:

```bash
rg -n -i '(github\\.com|dao-genesis|windsurf-assistant|/Users/|/home/|zhouyoukang|api[_-]?key[^`]*sk-|token[^`]*eyJ)' release-assets
```

Expected: no matches except generic placeholder text such as `YOUR_PROVIDER_API_KEY`.

### Task 2: Implement reproducible staging and packaging

**Files:**
- Create: `scripts/build-commercial-bundle.js`

- [ ] **Step 1: Define the release roots and clean staging**

The script must resolve `root = path.resolve(__dirname, "..")`, write to `dist/dao-flow-9.9.423-complete-bundle/`, and delete only its own previous `dist/.dao-flow-staging/` and generated bundle directory before recreating them. It must never remove the repository root or any source directory.

- [ ] **Step 2: Copy only runtime files**

Copy root runtime files (`extension.js`, `workspace_ignore_guard.js`, `dao-acp-stdio-proxy.js`, `acp-workspace-message.js`, `acp-session-lineage.js`, `acp-session-bridge.js`, `package.json`, `LICENSE.txt`) and the `core/`, `ui/`, `media/`, and selected `scripts/` directories. Copy `vendor/bundled-origin/` with `source.js`, `team-settings-cache.js`, `prompt_studio.html`, canonical prompt assets, and `_full_model_catalog.json`; copy `vendor/外接api/` runtime files plus `_默认配置.json` and `revproxy_console.html`. Copy `release-assets/README-先看这里.md` to staged `README.md`. Exclude tests, self-tests, logs, dumps, `配置.json`, generated state, old `源.js`, helper catalog mutation scripts, and all historical VSIX files.

- [ ] **Step 3: Sanitize the embedded manifest**

Parse the source `package.json`, delete `repository`, `homepage`, `bugs`, and `funding` if present, remove development-only `scripts` and `devDependencies`, retain current extension identity/settings/commands, and write the result to staged `package.json`. Do not alter the source `package.json`.

- [ ] **Step 4: Use a minimal staged `.vscodeignore`**

Write ignore rules for `*.vsix`, `.git*`, `test/**`, `docs/**`, `release-assets/**`, `dist/**`, runtime logs/dumps, `vendor/外接api/core/配置.json`, and generated prompt/config state. The staging tree itself must already be allowlisted so these rules are a second boundary, not the only boundary.

- [ ] **Step 5: Build the VSIX with the local toolchain**

Invoke the repository-local binary:

```bash
node_modules/.bin/vsce package --no-dependencies --allow-missing-repository --out dist/dao-flow-9.9.423-complete-bundle/dao-flow-9.9.423.vsix
```

Run with `cwd` set to the staging extension directory so the VSIX contains no source checkout metadata.

### Task 3: Add privacy and artifact audits to the release script

**Files:**
- Modify: `scripts/build-commercial-bundle.js`

- [ ] **Step 1: Inspect the VSIX manifest and file list**

Open `extension/package.json` from the generated VSIX and assert that `repository`, `homepage`, `bugs`, and `funding` are absent. List the ZIP entries and assert that tests, internal docs, logs, dumps, `配置.json`, `.git`, and historical VSIX entries are absent.

- [ ] **Step 2: Scan text content for private identifiers**

Read text-like entries from both the staged extension and final ZIP and fail on `github.com/dao-genesis`, `windsurf-assistant`, `/Users/a77/dao-proxy-pro`, `/home/`, `zhouyoukang`, or non-placeholder credential patterns. Allow provider documentation links such as `api.anthropic.com` and generic placeholders.

- [ ] **Step 3: Emit an audit report**

Write `dist/dao-flow-9.9.423-complete-bundle/发行审计.txt` containing the version, file counts, VSIX byte size, ZIP byte size, excluded-entry checks, and the exact clean-scan result. Do not include source paths or personal identifiers in the report.

### Task 4: Verify the release

**Files:**
- Modify: `scripts/build-commercial-bundle.js` only if a verification failure requires a packaging fix.

- [ ] **Step 1: Run syntax and focused runtime tests**

Run:

```bash
node --check scripts/build-commercial-bundle.js
node test/webview-syntax.test.js
npm run test:quick
npm run test:revproxy
node test/feature-coverage.test.js
```

Record failures caused by missing live provider credentials separately from packaging failures.

- [ ] **Step 2: Run the release build**

Run:

```bash
node scripts/build-commercial-bundle.js
```

Expected: a VSIX, buyer ZIP, and `发行审计.txt` under `dist/dao-flow-9.9.423-complete-bundle/` with a clean audit result.

- [ ] **Step 3: Inspect the final archive**

Run:

```bash
unzip -l dist/dao-flow-9.9.423-complete-bundle/dao-flow-9.9.423-complete-bundle.zip
unzip -p dist/dao-flow-9.9.423-complete-bundle/dao-flow-9.9.423.vsix extension/package.json
```

Expected: only the documented buyer files in the outer ZIP and no repository/homepage metadata in the embedded manifest.
