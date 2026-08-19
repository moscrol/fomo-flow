"use strict";

const assert = require("assert");
const router = require("../vendor/外接api/core/dao_router");

const resolve = router._test.resolveTargetProtocolDecision;

assert.equal(
  typeof resolve,
  "function",
  "resolveTargetProtocolDecision must be exported",
);

assert.deepStrictEqual(
  resolve(
    { provider: "cccc", model: "claude-opus-5", sourceProtocol: "anthropic" },
    { type: "openai-compatible", supportedProtocols: ["openai-chat"] },
    "claude-opus-5",
  ),
  {
    protocol: "openai-chat",
    configuredProtocol: "anthropic",
    source: "provider-capability",
    adjusted: true,
    reason: "configured-protocol-unsupported",
  },
);

assert.deepStrictEqual(
  resolve(
    {
      provider: "path-aware",
      model: "claude-opus-5",
      sourceProtocol: "openai-responses",
    },
    {
      type: "openai-compatible",
      completionPath: "/v1/messages",
      supportedProtocols: ["anthropic", "openai-chat"],
    },
    "claude-opus-5",
  ),
  {
    protocol: "anthropic",
    configuredProtocol: "openai-responses",
    source: "provider-capability",
    adjusted: true,
    reason: "configured-protocol-unsupported",
  },
);

assert.deepStrictEqual(
  resolve(
    {
      provider: "cccc",
      model: "claude-opus-5",
      protocol: "openai-chat",
      sourceProtocol: "anthropic",
    },
    { type: "openai-compatible", supportedProtocols: ["openai-chat"] },
    "claude-opus-5",
  ),
  {
    protocol: "openai-chat",
    configuredProtocol: "openai-chat",
    source: "channel-config",
    adjusted: false,
    reason: "",
  },
);

assert.deepStrictEqual(
  resolve(
    {
      provider: "cccc",
      model: "claude-opus-5",
      protocol: "anthropic",
      sourceProtocol: "openai-chat",
    },
    {
      type: "openai-compatible",
      completionPath: "/v1/messages",
      supportedProtocols: ["anthropic", "openai-chat"],
    },
    "claude-opus-5",
  ),
  {
    protocol: "anthropic",
    configuredProtocol: "anthropic",
    source: "channel-config",
    adjusted: false,
    reason: "",
  },
  "a cache-capable explicit channel protocol must win without changing provider order",
);

assert.deepStrictEqual(
  resolve(
    { provider: "ccc", model: "claude-opus-5", sourceProtocol: "anthropic" },
    {
      type: "openai-compatible",
      supportedProtocols: ["anthropic", "openai-chat"],
    },
    "claude-opus-5",
  ),
  {
    protocol: "anthropic",
    configuredProtocol: "anthropic",
    source: "route-config",
    adjusted: false,
    reason: "",
  },
);

assert.deepStrictEqual(
  resolve(
    {
      provider: "unknown",
      model: "claude-opus-5",
      sourceProtocol: "anthropic",
    },
    { type: "openai-compatible" },
    "claude-opus-5",
  ),
  {
    protocol: "anthropic",
    configuredProtocol: "anthropic",
    source: "route-config",
    adjusted: false,
    reason: "",
  },
);

assert.equal(
  resolve(
    { model: "gpt-5.6-sol", reasoningLevel: "high" },
    {
      type: "openai-compatible",
      supportedProtocols: ["openai-chat", "openai-responses"],
    },
    "gpt-5.6-sol",
  ).protocol,
  "openai-responses",
);

assert.equal(
  resolve(
    { model: "gemini-3.1-pro" },
    { type: "gemini", supportedProtocols: ["gemini"] },
    "gemini-3.1-pro",
  ).protocol,
  "gemini",
);

const candidates = [
  { provider: "cccc", model: "claude-opus-5", protocol: "openai-chat" },
  { provider: "ccc", model: "claude-opus-5", protocol: "anthropic" },
];
const beforeOrder = candidates.map((candidate) => candidate.provider);
for (const candidate of candidates) {
  resolve(
    candidate,
    {
      type: "openai-compatible",
      supportedProtocols: [candidate.protocol],
    },
    candidate.model,
  );
}
assert.deepStrictEqual(
  candidates.map((candidate) => candidate.provider),
  beforeOrder,
  "protocol resolution must not reorder or replace providers",
);

console.log("dynamic channel protocol selftest: PASS");
