"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readFresh: readCache } = require(
  "../vendor/bundled-origin/team-settings-cache.js"
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dao-team-settings-"));
const cachePath = path.join(root, "team_settings.bin");
const body = Buffer.from([8, 1, 18, 3, 100, 97, 111]);

try {
  fs.writeFileSync(cachePath, body);
  assert.deepStrictEqual(readCache(cachePath), body, "fresh protobuf cache must load");

  const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(cachePath, stale, stale);
  assert.strictEqual(readCache(cachePath), null, "stale cache must fall through");

  fs.writeFileSync(cachePath, Buffer.from([0, 0, 0]));
  assert.strictEqual(readCache(cachePath), null, "framed/invalid tag-zero cache is unsafe");

  console.log("team settings cache selftest: PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
