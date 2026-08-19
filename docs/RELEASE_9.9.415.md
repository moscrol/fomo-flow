# dao-proxy-pro 9.9.415

## Codex Hot Route

- Adds module 8 beside the existing seven modules.
- Lets channels from module 2 replace Codex's URL/key by installing one stable local Responses provider in `~/.codex/config.toml`.
- Uses `dao_proxy_hot` as the Codex provider and `dao-codex-hot` as the Codex model.
- Requires one Codex restart only on the first takeover, because Codex reads `config.toml` at startup.
- Subsequent provider, model, protocol, and reasoning-effort changes hot-switch inside dao-proxy-pro without changing Codex's stable local URL/key.

## Search And Cache

- Hides local `grep_search` match output from the Devin conversation body.
- Keeps the full grep tool result available to the model and to the existing cross-turn transcript restoration path.
- Keeps Devin-native `code_search / Fast Context`; the plugin does not replace semantic search.
- Confirms Chinese workspace paths and Chinese Fast Context search terms are not the cause of previous Skipped behavior.
- Keeps the current Responses cache strategy: stable prompt cache key, connection affinity, and `dao-output://` persistence for large tool outputs.

## Compatibility

- Old 9.9.353 code was checked for cache behavior and did not include a better OpenAI cache mechanism.
- The new Codex route does not expose upstream API keys through the webview or status API.
- Temporary test config files are used in regression tests; the real user `~/.codex/config.toml` is not modified by tests.
