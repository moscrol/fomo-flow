# dao-proxy-pro 9.9.410

## Fast Context nested Windows path guard

The outer `code_search` path already uses the native Windows-safe form:

```text
E:/新增运行时状态机
```

Live Devin logs showed that the native Fast Context subagent could still emit a nested tool call containing an unescaped path such as `Assets\\Runtime...`. Its JSON parser then failed before searching:

```text
instant_context_agent.go: Error parsing tool call arguments: invalid character 'R' in string escape code
```

This release appends one stable instruction to Windows `code_search.search_term`: nested tools must use workspace-relative paths or forward-slash absolute paths. The guard is idempotent and does not replace Fast Context. Devin LSP/Cortex still owns indexing, semantic search, nested tool execution, and result rendering.

Other workspace tools are unchanged.
