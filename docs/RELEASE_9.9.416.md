# dao-proxy-pro 9.9.416

## Codex To Devin Status Sync

- Module 8 now reads a safe snapshot of Codex `config.toml` and displays the actual model provider, model, reasoning effort, wire API, and base URL in Devin.
- The active module 8 pane polls only the lightweight status endpoint every three seconds.
- External Codex configuration changes become visible without rediscovering providers or models.
- A mismatch is shown when Codex points somewhere other than the saved hot route.

## Account And History Preservation

- The hot route remains configuration-only.
- It does not read or write the Codex authentication cache, account session, thread database, rollout files, or chat history.
- Existing account sign-in and saved conversations therefore remain intact while provider routing changes.
- The status endpoint reports the preservation scope but never returns bearer-token or upstream-key contents.

## Verification

- Tests use isolated temporary `config.toml`, auth-cache, and thread-history files.
- First takeover, repeated hot switch, external config edit, secret redaction, and byte-for-byte auth/history preservation are covered.
