# dao-proxy-pro 9.9.413

## Devin Fast Context workspace indexing

- Fixes an unsafe Unity `.codeiumignore` rule where `Library/` could also match project-owned resources under `Assets/Library/`.
- Rewrites only the exact existing `Library/` rule to `/Library/`.
- Does not create `.codeiumignore`, scan project files, replace Fast Context, or restart Devin services.
- Preserves every other user-authored ignore rule and line ending.
- Applies to every folder in a multi-root workspace and to folders added later.
- The repair is idempotent: already-safe workspaces perform no write.

Fast Context, `find_by_name`, `grep_search`, `read_file`, and terminal execution remain Devin-native tools. The Responses tool-output cache introduced in 9.9.412 is unchanged.
