# dao-proxy-pro 9.9.418

## Codex hot channel switching

- Keeps the active Codex provider, model, reasoning effort, context, notifications, authentication mode, and unrelated TOML settings unchanged.
- Patches only `base_url` and `experimental_bearer_token` in the active provider section so Codex can use a stable local Responses endpoint.
- Adds a `⑧Codex` action to every user channel in module 2 for immediate upstream switching after the one-time takeover reload.
- Uses `/codex-hot/v1/responses` as an isolated data path. It does not overwrite module 3 routes and ignores module 4 exposure filters.
- Migrates the legacy `dao_proxy_hot / dao-codex-hot` takeover back to the provider, model, and reasoning values stored in the existing backup.

## Verification

- TOML regression verifies that only the active provider URL and token change.
- Migration regression verifies restoration from the legacy takeover.
- Real HTTP regression verifies `gpt-5.6-sol` routes to the selected channel with Responses `high`, even when module 3 has a conflicting same-model route and module 4 disables that model.
- The full routing, tool, cache, workspace, ACP, Webview, and change-tracker test suites pass.
