# dao-proxy-pro 9.9.414

## Native Fast Context query passthrough

- Stops appending proxy-authored Windows and result-scope instructions to `code_search.search_term`.
- Preserves the model-generated Fast Context query byte for byte.
- Keeps only the required Windows outer-path normalization from backslashes to forward slashes.
- Keeps Devin's native `code_search` tool name, arguments, execution, indexing, and result handling.
- Retains the 9.9.413 Unity `.codeiumignore` repair.
- Does not change the Responses cache strategy or add a retry/model round.

This removes the last proxy-owned modification inside Fast Context queries and returns semantic search behavior to Devin's official implementation.
