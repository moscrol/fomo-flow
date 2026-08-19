"use strict";

const assert = require("node:assert");
const { classifyCachePrefixContinuity } = require("../core/cache_prefix_continuity.js");

const hex = (value) => value.toString(16).padStart(12, "0");
const request = (overrides = {}) => ({
  at: 1,
  provider: "cccc",
  model: "claude-opus-5",
  cacheKeyHash: "aaaaaaaaaaaa",
  cacheFamilyHash: "bbbbbbbbbbbb",
  stableMessageCount: 3,
  stableItemHashes: [hex(1), hex(2), hex(3)],
  ...overrides,
});

const classified = classifyCachePrefixContinuity([
  request(),
  request({
    at: 2,
    stableMessageCount: 5,
    stableItemHashes: [hex(1), hex(2), hex(3), hex(4), hex(5)],
  }),
  request({
    at: 3,
    stableMessageCount: 4,
    stableItemHashes: [hex(1), hex(2), hex(9), hex(10)],
  }),
  request({
    at: 4,
    cacheKeyHash: "cccccccccccc",
    cacheFamilyHash: "dddddddddddd",
    stableMessageCount: 2,
    stableItemHashes: [hex(7), hex(8)],
  }),
  request({
    at: 5,
    cacheKeyHash: "cccccccccccc",
    cacheFamilyHash: "dddddddddddd",
    stableMessageCount: 0,
    stableItemHashes: [],
  }),
]);

assert.deepStrictEqual(
  classified.map(({ prefixState, prefixGeneration, prefixReason }) => ({
    prefixState,
    prefixGeneration,
    prefixReason,
  })),
  [
    { prefixState: "cold", prefixGeneration: 1, prefixReason: "first-family-sample" },
    { prefixState: "append-only", prefixGeneration: 1, prefixReason: "stable-prefix-extended" },
    { prefixState: "rewritten", prefixGeneration: 2, prefixReason: "stable-prefix-rewritten" },
    { prefixState: "family-changed", prefixGeneration: 3, prefixReason: "cache-family-changed" },
    { prefixState: "unknown", prefixGeneration: 3, prefixReason: "insufficient-prefix-evidence" },
  ],
);

const previousLong = Array.from({ length: 256 }, (_, index) => hex(index + 45));
const currentLong = [...previousLong.slice(3), hex(301), hex(302), hex(303)];
const longSession = classifyCachePrefixContinuity([
  request({ at: 10, stableMessageCount: 300, stableItemHashes: previousLong }),
  request({ at: 11, stableMessageCount: 303, stableItemHashes: currentLong }),
]);
assert.strictEqual(longSession[1].prefixState, "append-only");

const serialized = JSON.stringify(classified);
assert.doesNotMatch(serialized, /prompt|Authorization|\/Users\//i);
assert.ok(classified.every((item) => !Object.hasOwn(item, "cacheKeyHash")));
assert.ok(classified.every((item) => !Object.hasOwn(item, "stableItemHashes")));

console.log("cache prefix continuity: PASS");
