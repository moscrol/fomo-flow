# Dao Dynamic Channel Protocol Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `cccc` as the first `dao-opus-5` channel, send that channel through OpenAI Chat, and dynamically prevent known provider capability data from being overridden by an incompatible configured protocol.

**Architecture:** The existing custom-model API performs the immediate, explicit channel-only configuration update. A pure protocol-resolution result inside `dao_router.js` then separates configured protocol from actual protocol and uses non-empty `supportedProtocols` as a hard capability boundary. Existing route dispatch, provider order, fallback, budget and affinity remain unchanged; renderer-facing model data receives only safe protocol labels and adjustment reasons.

**Tech Stack:** Node.js/CommonJS Dao runtime, React/TypeScript Desktop renderer, existing loopback custom-model API, Node self-tests, Vitest.

---

## File map

- `vendor/外接api/core/dao_router.js`: resolve configured versus actual channel protocol and expose a test seam.
- `test/dynamic-channel-protocol.test.js`: focused protocol-capability and priority invariants.
- `desktop/src/components/control/CustomModelsControlView.tsx`: show configured/actual protocol facts when runtime supplies them.
- `desktop/src/components/control/CustomModelsControlView.test.tsx`: safe beginner-facing adjustment copy.
- Runtime configuration files: update only the existing `cccc` channel in `dao-opus-5`; create private timestamped backups before write.

### Task 1: Change the live cccc channel without changing priority

**Files:**
- Modify through existing API: active Dao runtime custom model `dao-opus-5`
- Verify: `~/.codeium/dao-byok/配置.json`
- Verify if present: `~/Library/Application Support/dao-flow-desktop/config/配置.json`

- [x] **Step 1: Capture the current safe invariant**

Run a read-only script against `GET /origin/ea/custom-models` and assert:

```js
const model = models.find((item) => item.id === 'dao-opus-5')
assert.equal(model.channels[0].provider, 'cccc')
assert.equal(model.channels[0].upstreamModel, 'claude-opus-5')
```

Expected: first channel is `cccc`; no secret or full URL is printed.

- [x] **Step 2: Create private recoverable backups**

Copy each configuration that contains the channel to a timestamped sibling file with mode `0600`. Validate that the backup parses before writing the source.

- [x] **Step 3: Update through the existing custom-model API**

POST the current safe model fields with the channel array unchanged except:

```json
{
  "provider": "cccc",
  "upstreamModel": "claude-opus-5",
  "protocol": "openai-chat"
}
```

Keep reasoning settings, provider, model, channel strategy and array order unchanged. The running
Devin Router was verified to prioritize the top-level model protocol over the channel protocol, so
the top-level protocol was also set to `openai-chat`; otherwise the request continued to use the
Anthropic cache contract despite the channel label. This is a configuration compatibility fix and
does not modify the Devin plugin.

- [x] **Step 4: Verify hot runtime state**

Read `GET /origin/ea/custom-models` again and assert channel zero is still `cccc`, its protocol is `openai-chat`, and no other channel moved. Read the source JSON back to assert the same values.

### Task 2: Add capability-aware protocol resolution test-first

**Files:**
- Modify: `vendor/外接api/core/dao_router.js`
- Create: `test/dynamic-channel-protocol.test.js`

- [x] **Step 1: Write the failing focused test**

Use `router._test.resolveTargetProtocolDecision` with these exact cases:

```js
assert.deepEqual(
  resolve(
    { protocol: 'anthropic' },
    { type: 'openai-compatible', supportedProtocols: ['openai-chat'] },
    'claude-opus-5'
  ),
  {
    protocol: 'openai-chat',
    configuredProtocol: 'anthropic',
    source: 'provider-capability',
    adjusted: true,
    reason: 'configured-protocol-unsupported'
  }
)
```

Also cover supported Anthropic, channel-level Chat, missing capability data, Responses, Gemini and candidate-order invariants.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node test/dynamic-channel-protocol.test.js`

Expected: FAIL because `resolveTargetProtocolDecision` is absent.

- [x] **Step 3: Implement the pure decision function**

Add `_resolveTargetProtocolDecision(target, providerConfig, model)` returning the five safe fields. Normalize capability names with `_endpointProtocol`; when the advertised list is non-empty, accept explicit values only when advertised. Deterministically prefer a provider/completion-path match, then Chat for `openai-compatible`, then the first normalized advertised protocol. If the list is empty, retain the existing explicit/detection behavior.

Keep `_resolveTargetProtocol(...)` as a compatibility wrapper:

```js
function _resolveTargetProtocol(target, providerConfig, model) {
  return _resolveTargetProtocolDecision(target, providerConfig, model).protocol
}
```

- [x] **Step 4: Attach safe adjustment facts to routing observation**

At the existing protocol-resolution call site, retain only protocol names, source and fixed reason in route diagnostics/decision evidence. Do not add provider calls, configuration writes, secrets, paths or request identifiers.

- [x] **Step 5: Run focused and root regressions**

Run:

```bash
node test/dynamic-channel-protocol.test.js
node vendor/外接api/core/dao-test.js --quick
node test/prompt-cache-router.test.js
node test/routing-advisory.test.js
```

Expected: all pass and the configured candidate order remains unchanged.

- [x] **Step 6: Commit the runtime change**

```bash
git add vendor/外接api/core/dao_router.js test/dynamic-channel-protocol.test.js
git commit -m "fix: honor channel protocol capabilities"
```

Committed by staging only the six protocol-resolution/observation hunks plus the focused test and
UI changes. The staged snapshot was tested independently so unrelated working-tree changes were not
captured as hidden dependencies.

### Task 3: Explain actual protocol in the custom-model UI

**Files:**
- Modify: `desktop/src/components/control/CustomModelsControlView.tsx`
- Modify: `desktop/src/components/control/CustomModelsControlView.test.tsx`

- [x] **Step 1: Write the failing UI test**

Return a model/channel runtime projection containing:

```ts
{
  configuredProtocol: 'anthropic',
  actualProtocol: 'openai-chat',
  protocolAdjusted: true,
  protocolReason: 'configured-protocol-unsupported'
}
```

Assert the card renders “实际使用 OpenAI Chat” and “渠道不支持配置协议，已按渠道能力发送”, while no endpoint, key or Authorization appears.

- [x] **Step 2: Run the test and verify RED**

Run: `cd desktop && npm test -- --run src/components/control/CustomModelsControlView.test.tsx`

Expected: FAIL because the adjustment facts are not rendered.

- [x] **Step 3: Implement bounded safe copy**

Accept only known protocol enum values and the fixed reason enum. Render configured protocol only when it differs from actual protocol; otherwise retain the current compact card. Do not render raw runtime error strings.

- [x] **Step 4: Verify Desktop and full project**

Run:

```bash
cd desktop
npm test -- --run src/components/control/CustomModelsControlView.test.tsx
npm test
npm run typecheck
npm run lint
npm run build
cd ..
npm test
```

Expected: all commands exit zero; lint may retain pre-existing warnings but has no errors.

- [x] **Step 5: Observe real cccc cache facts**

After the user sends at least two further requests in the same Devin session, read the safe usage endpoint and report actual protocol, cached tokens, cache-write tokens and hit rate. Do not generate a user prompt merely to create cache traffic.

Observed on the first four real post-change requests: the first request established the implicit
provider cache, then the next three reported 28,936 / 60,644 / 61,481 cached tokens with 47.8% /
97.7% / 96.9% per-request hit rates. The stable cache key was present, the provider/model/priority
were unchanged, and OpenAI Chat correctly reported no separate cache-write token counter.
