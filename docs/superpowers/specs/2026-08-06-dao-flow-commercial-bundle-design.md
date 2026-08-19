# Dao Flow Commercial Bundle Design

## Goal

Create a buyer-ready distribution bundle for the current Dao Flow implementation. The bundle is intended for direct delivery to a buyer and focuses on Devin Local BYOK, with the remaining supported features documented as optional workflows.

The release source of truth is the current working tree at packaging time. Existing historical VSIX files are not reused.

## Non-goals

- Do not change runtime routing, protocol handling, persistence paths, or extension identifiers.
- Do not publish or expose the source repository, repository URL, internal absolute paths, development history, tests, or design artifacts.
- Do not include provider credentials, local runtime state, request captures, diagnostic logs, or user-specific configuration.
- Do not promise provider quota, model availability, account entitlement, or guaranteed access to a third-party service.

## Release Architecture

Packaging uses a disposable staging directory populated from the current working tree. The source tree is not used as the final ZIP root and is not rewritten for release-only metadata changes.

The staged extension keeps the runtime files required by the extension host:

- `package.json`, `extension.js`, ACP bridge files, and workspace guard.
- `core/` runtime modules used by the origin server, task/HUD/telemetry projection, and Codex/Devin change bridge.
- `ui/` webview assets.
- `vendor/bundled-origin/` runtime server, prompt studio, model catalogs, canonical prompt assets, and team-settings cache.
- `vendor/外接api/` runtime facade and core routing/adapters/reverse-proxy modules.
- `scripts/` reset and MCP helper scripts when referenced by a supported workflow.
- `media/` icons and the license.

The staged `package.json` keeps the current extension name, publisher, version, commands, settings, and activation behavior, but omits repository and homepage metadata. The staged README is buyer-facing and contains no source links or internal paths.

The final ZIP has this shape:

```text
dao-flow-9.9.423-complete-bundle.zip
  dao-flow-9.9.423.vsix
  README-先看这里.md
  使用说明书-中文.md
  配置示例/
    配置.json.example
    revproxy.json.example
    protocol-bridge.json.example
  LICENSE.txt
```

No source checkout, test suite, `.git` data, historical VSIX, internal release notes, superpowers artifacts, or runtime captures are included.

## Buyer Documentation

`使用说明书-中文.md` is organized around the buyer's first successful Devin Local BYOK request:

1. What the plugin does and what the buyer must provide.
2. Supported host assumptions and installation from VSIX.
3. First launch and local control plane verification.
4. Provider setup: base URL, protocol, API key, model list, headers, and optional pricing.
5. Model UID to upstream model routing, priority fallback, health probe, circuit breaker, and session affinity.
6. Thinking/reasoning configuration and custom model setup.
7. Local reverse proxy for OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini-compatible calls.
8. Protocol bridge profiles for Codex, Claude Code, OpenCode, MiMoCode, OpenClaw, and Hermes where supported by the runtime.
9. Model catalog controls, project prompt workspace, Agent HUD, Codex hot route, terminal sessions, and file-change review.
10. Configuration export/import and safe migration between computers.
11. Troubleshooting by symptom, including official direct-connection restore.
12. Security boundaries, API-key handling, localhost defaults, public tunnel warnings, and provider/account responsibility.

Examples use placeholders only. They must not contain real keys, the author's path, or a repository URL.

## Privacy and Leak Prevention

The staging build must exclude or scrub:

- `repository`, `homepage`, and source checkout metadata from the embedded extension manifest.
- Repository names, repository URLs, local absolute paths, developer usernames, and internal handoff references from buyer-visible documents.
- `配置.json`, runtime logs, request dumps, prompt captures, action-audit files, backup files, and generated state.
- Historical `.vsix` artifacts and internal tests/docs that reveal implementation history.

The release audit scans both the ZIP and the embedded VSIX contents for repository identifiers, `/Users/`, `/home/`, Windows developer paths, known personal usernames, common credential key names with non-example values, and excluded file classes. A clean scan is a release gate.

## Verification

Before delivery:

1. Run syntax checks on staged JavaScript and the webview syntax test.
2. Run the focused routing, reverse-proxy, cache-resilience, custom-model, and observability tests that are available without external provider credentials.
3. Build the staged VSIX with `vsce` and inspect its manifest and file list.
4. Run the privacy/leak scan against both VSIX and ZIP.
5. Verify the ZIP can be extracted and contains only the documented buyer-facing files.
6. Report any checks that require a live Devin account, provider API key, or network access as unverified rather than implying full end-to-end validation.

## Assumptions

- The current working tree is the intended release candidate, including uncommitted runtime changes already present when packaging begins.
- Buyers install the VSIX into Devin Local or another compatible VS Code-family host.
- Provider API keys are entered by the buyer on the buyer's machine and are not part of the delivery bundle.
- The first release preserves existing extension identifiers and user data paths so upgrades remain compatible.
