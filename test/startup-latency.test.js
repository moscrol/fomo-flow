"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempHome = path.join(os.tmpdir(), `dao-startup-latency-${process.pid}`);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;

const sourcePath = path.join(
  __dirname,
  "..",
  "vendor",
  "bundled-origin",
  "source.js",
);

async function main() {
  const moduleStart = Date.now();
  const origin = require(sourcePath);
  const requireMs = Date.now() - moduleStart;
  const listenStart = Date.now();
  const handle = await origin.start({
    port: 0,
    host: "127.0.0.1",
    mode: "invert",
  });
  const listenMs = Date.now() - listenStart;

  assert(
    listenMs < 5000,
    `origin startup blocked for ${listenMs}ms; endpoint discovery must not run synchronous network probes`,
  );
  assert(handle.port > 0, "origin must bind an ephemeral port");

  await handle.close();
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {}
  console.log(
    `startup latency selftest: PASS (require=${requireMs}ms listen=${listenMs}ms)`,
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  },
);
