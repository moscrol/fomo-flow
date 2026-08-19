"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");
const {
  createWebHudHttpHandler,
  isLoopbackAddress,
} = require("../core/web_hud_http.js");

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }

  end(chunk) {
    if (chunk != null) this.write(chunk);
    this.writableEnded = true;
    this.emit("finished");
  }

  body() {
    return this.chunks.join("");
  }
}

const assets = {
  "web-hud.html": "<!doctype html><title>FOMO FLOW HUD</title>",
  "web-hud.css": ":root{color-scheme:dark}",
  "web-hud.js": "\"use strict\";",
};
let subscribed = 0;
const service = {
  snapshot() {
    return { version: 1, runtime: { healthy: true } };
  },
  subscribe(response) {
    subscribed += 1;
    response.write("event: snapshot\ndata: {\"version\":1}\n\n");
    return { ok: true, dispose() {} };
  },
};
const handler = createWebHudHttpHandler({
  service,
  assetDir: "/safe/assets",
  readFile(file, callback) {
    const filename = path.basename(file);
    process.nextTick(() => {
      if (!Object.prototype.hasOwnProperty.call(assets, filename)) {
        callback(new Error(`/private/path/${filename}`));
        return;
      }
      callback(null, Buffer.from(assets[filename]));
    });
  },
});

function request(url, method = "GET", remoteAddress = "127.0.0.1") {
  const req = { url, method, headers: {}, socket: { remoteAddress } };
  const res = new FakeResponse();
  const handled = handler(req, res);
  return { handled, req, res };
}

function finished(res) {
  if (res.writableEnded) return Promise.resolve();
  return new Promise((resolve) => res.once("finished", resolve));
}

(async function main() {
  const originSource = fs.readFileSync(
    path.join(__dirname, "..", "vendor", "bundled-origin", "source.js"),
    "utf8",
  );
  assert.match(
    originSource,
    /req\.url === "\/hud"[\s\S]{0,100}req\.url\.startsWith\("\/hud\/"\)/,
    "the top-level Origin dispatcher must send static HUD paths to handleControl",
  );
  assert(originSource.includes('require(\n      path.join(__dirname, "..", "..", "core", "codex_rollout_source.js"),\n    )'));
  assert(originSource.includes("codexSummaries: () => codexSource.list()"));
  assert(originSource.includes("codexHealth: () => codexSource.health()"));
  assert(originSource.includes("codexRoute: () =>"));
  assert(originSource.includes("codexMod.status"));
  assert(originSource.includes('u.pathname === "/origin/tasks"'));
  assert(originSource.includes("createTaskApiHandler"));
  assert(originSource.includes("tasks: () =>"));
  assert.match(originSource, /if \(await handleControl\(req, res\)\) return;/);

  assert.strictEqual(isLoopbackAddress("127.0.0.1"), true);
  assert.strictEqual(isLoopbackAddress("::1"), true);
  assert.strictEqual(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.strictEqual(isLoopbackAddress("192.168.1.10"), false);
  assert.strictEqual(isLoopbackAddress(""), false);

  for (const [url, mime, bodyPart] of [
    ["/hud", "text/html; charset=utf-8", "FOMO FLOW HUD"],
    ["/hud/", "text/html; charset=utf-8", "FOMO FLOW HUD"],
    ["/hud/web-hud.css", "text/css; charset=utf-8", "color-scheme"],
    ["/hud/web-hud.js", "text/javascript; charset=utf-8", "use strict"],
  ]) {
    const result = request(url);
    assert.strictEqual(result.handled, true);
    await finished(result.res);
    assert.strictEqual(result.res.statusCode, 200);
    assert.strictEqual(result.res.headers["content-type"], mime);
    assert.match(result.res.body(), new RegExp(bodyPart));
    assert.strictEqual(result.res.headers["cache-control"], "no-store");
    assert.strictEqual(result.res.headers["x-content-type-options"], "nosniff");
    assert.strictEqual(result.res.headers["referrer-policy"], "no-referrer");
    assert.match(result.res.headers["content-security-policy"], /default-src 'none'/);
    assert.match(result.res.headers["content-security-policy"], /script-src 'self'/);
    assert.match(result.res.headers["content-security-policy"], /style-src 'self'/);
    assert.match(result.res.headers["content-security-policy"], /connect-src 'self'/);
    assert.match(result.res.headers["content-security-policy"], /frame-ancestors 'self' file:/);
  }

  const snapshot = request("/origin/hud/snapshot");
  assert.strictEqual(snapshot.handled, true);
  assert.strictEqual(snapshot.res.statusCode, 200);
  assert.strictEqual(snapshot.res.headers["content-type"], "application/json; charset=utf-8");
  assert.deepStrictEqual(JSON.parse(snapshot.res.body()), { version: 1, runtime: { healthy: true } });

  const events = request("/origin/hud/events");
  assert.strictEqual(events.handled, true);
  assert.strictEqual(events.res.statusCode, 200);
  assert.strictEqual(events.res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.strictEqual(events.res.headers.connection, "keep-alive");
  assert.match(events.res.body(), /^event: snapshot/);
  assert.strictEqual(subscribed, 1);

  const forbidden = request("/hud", "GET", "10.0.0.8");
  assert.strictEqual(forbidden.res.statusCode, 403);
  assert.deepStrictEqual(JSON.parse(forbidden.res.body()), { ok: false, error: "localhost only" });

  const wrongMethod = request("/origin/hud/snapshot", "POST");
  assert.strictEqual(wrongMethod.res.statusCode, 405);
  assert.deepStrictEqual(JSON.parse(wrongMethod.res.body()), { ok: false, error: "method not allowed" });

  const missing = request("/hud/unknown");
  assert.strictEqual(missing.handled, true);
  assert.strictEqual(missing.res.statusCode, 404);
  assert.doesNotMatch(missing.res.body(), /safe\/assets|private\/path/);

  const passthrough = request("/v1/chat/completions");
  assert.strictEqual(passthrough.handled, false);
  assert.strictEqual(passthrough.res.writableEnded, false);

  console.log("web hud http: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
