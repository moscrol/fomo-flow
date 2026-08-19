"use strict";

const assert = require("node:assert");
const adapters = require("../vendor/外接api/core/adapters.js");

const anthropic = adapters.adapterFor("anthropic");
assert.ok(anthropic, "Anthropic adapter must be available");

const relayHeaders = anthropic.buildRequestOpts(
  { type: "openai-compatible", apiKey: "relay-secret" },
  {},
  new URL("https://relay.invalid/v1/messages"),
).headers;

assert.strictEqual(relayHeaders["x-api-key"], "relay-secret");
assert.strictEqual(
  relayHeaders.Authorization,
  "Bearer relay-secret",
  "Anthropic-compatible relays need bearer affinity as well as x-api-key auth",
);

const officialHeaders = anthropic.buildRequestOpts(
  { type: "anthropic", apiKey: "official-secret" },
  {},
  new URL("https://api.anthropic.com/v1/messages"),
).headers;

assert.strictEqual(officialHeaders["x-api-key"], "official-secret");
assert.strictEqual(
  officialHeaders.Authorization,
  undefined,
  "official Anthropic keeps its x-api-key-only contract",
);

console.log("anthropic relay auth selftest: PASS");
