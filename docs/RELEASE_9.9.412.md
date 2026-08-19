# dao-proxy-pro 9.9.412

## Bounded historical tool output

Long Devin conversations previously kept every file read and command result inline. Logs showed stable cache, system, and tool-definition hashes, but the request grew from about 103k to 256k input tokens and aggregate cache reuse fell to 26.8%.

This release changes only the historical tool-result layer:

- All Responses routes persist older large tool results by default.
- The four newest tool results remain fully inline for immediate reasoning.
- Older results keep a deterministic `dao-output://` reference plus head/tail preview with file paths and line context.
- `dao_read_tool_output` can retrieve the full stored result in chunks for both ordinary routes and custom models.
- `contextStrategy.persistToolOutputs: false` restores fully inline behavior.

Devin still owns file search, Grep, file reading, Fast Context, edits, and terminal execution. The plugin does not add a replacement search engine or an extra model round.

## Verification

- Tool strategy integration, including ordinary Responses routes and explicit opt-out.
- 307 quick end-to-end assertions.
- Cache resilience and context strategy suites.
- Workspace strategy, native Fast Context priority, and local workspace suites.
- Strict project-prompt preservation suite.
