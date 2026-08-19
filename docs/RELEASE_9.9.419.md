# dao-proxy-pro 9.9.419

Fixes the `404 page not found` response from `/codex-hot/v1/responses` by registering the Codex hot path in the main HTTP dispatcher as well as the inner reverse-proxy gate.

Verification covers both dispatcher gates and the real HTTP Responses route with the selected provider and reasoning effort.
