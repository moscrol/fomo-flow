# dao-proxy-pro 9.9.411

## Bounded native Fast Context results

The Windows `code_search` query guard now combines two stable rules:

- Nested tool paths use workspace-relative paths or forward-slash absolute paths.
- Results contain only the smallest relevant symbol ranges, never complete files, with at most 8 files and 80 lines per file.

The guard also asks the agent to return file paths, symbols, call relationships, and exact line ranges, then use `grep_search` or `read_file` for additional detail.

The plugin does not truncate or rewrite native tool results. Devin LSP/Cortex still owns Fast Context indexing, execution, and rendering.
