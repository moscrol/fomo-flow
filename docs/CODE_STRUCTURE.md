# Code Structure

This index documents the main runtime boundaries. New behavior should be added to the owning module instead of growing the entry files again.

## Extension host

- `extension.js`: VS Code/Devin activation, commands, process lifecycle, Webview providers, and host message handling.
- `dao-acp-stdio-proxy.js`: ACP child-process lifecycle and stdio transport wiring.
- `acp-workspace-message.js`: narrow `session/new` workspace-root registration for ACP/Cortex search.
- `ui/ea-config-html.js`: CSP-safe assembly and syntax validation for the seven-module configuration Webview.
- `ui/ea-config.css`: configuration Webview styles.
- `ui/ea-config-client.js`: browser-side interaction for modules 1 through 7.

## Origin proxy

- `vendor/bundled-origin/source.js`: local origin server, request interception, prompt transformation, model catalog injection, and control-plane routing.
- `vendor/bundled-origin/team-settings-cache.js`: persistent team-settings cache.

## External API runtime

- `vendor/外接api/runtime.js`: extension-facing runtime facade.
- `vendor/外接api/core/dao_router.js`: Cascade request routing, failover, provider calls, cache affinity, and hot-configuration facade.
- `vendor/外接api/core/agent_status.js`: per-session execution state, outbound status injection, atomic persistence, and sanitized update events.
- `vendor/外接api/core/custom_model_registry.js`: custom-model CRUD, capability inference, ordered channel persistence, and catalog generation.
- `vendor/外接api/core/context_strategy.js`: context checkpoint and compaction state machine.
- `vendor/外接api/core/prompt_cache_policy.js`: protocol-aware cache breakpoints, capability downgrade, stable-prefix diagnostics, and bounded warmup scheduling.
- `vendor/外接api/core/tool_strategy.js`: tool selection and deferred MCP activation.
- `vendor/外接api/core/workspace_tool_strategy.js`: workspace-bound tool fallback.
- `vendor/外接api/core/local_workspace_tools.js`: bounded local filename/text/code search when Devin's Cortex workspace index is empty.
- `vendor/外接api/core/adapters.js`: OpenAI Chat/Responses, Anthropic, and Gemini protocol adapters.
- `vendor/外接api/core/revproxy.js`: standard SDK-facing reverse proxy.
- `vendor/外接api/core/protocol_bridge.js`: protocol conversion profiles.

## Agent HUD

- `core/agent_hud.js`: pure projection from sanitized session summaries to active/stale TTL views, multi-session aggregation, pin selection, and display-safe text. It must remain independent of VS Code APIs and raw prompt, tool, path, or credential data.
- `core/agent_hud_vscode.js`: VS Code status-bar presentation and Agent HUD interaction for Auto/On/Off modes, session pinning, and safe details. It owns UI lifecycle only; session state and route truth stay in `agent_status.js`, while projection rules stay in `agent_hud.js`.

## Change rules

1. Keep `extension.js`, `source.js`, and `dao_router.js` as orchestration layers.
2. Put stateful domain behavior behind a small module API and inject mutable runtime dependencies.
3. Keep browser UI assets under `ui/`; do not embed another multi-thousand-line template in the extension entry.
4. Run `test/webview-syntax.test.js`, prompt-cache policy/router tests, custom-model tests, cache-resilience tests, and the core test suite after changing a boundary.
