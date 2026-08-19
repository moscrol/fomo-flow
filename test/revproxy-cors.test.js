"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-cors-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const origin = require("../vendor/bundled-origin/source.js");

function mockResponse() {
  return {
    headers: {},
    statusCode: 0,
    ended: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end() {
      this.ended = true;
    },
  };
}

(async () => {
  try {
    const paths = [
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/messages",
      "/v1beta/models/test:generateContent",
    ];
    for (const requestPath of paths) {
      const request = {
        url: requestPath,
        method: "OPTIONS",
        headers: {
          origin: "vscode-webview://dao-proxy-pro",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization,content-type,x-api-key,x-goog-api-key,anthropic-version",
          "access-control-request-private-network": "true",
        },
      };
      const response = mockResponse();
      const handled = await origin._maybeRevproxy(request, response);
      assert.strictEqual(handled, true, `${requestPath} not routed`);
      assert.strictEqual(response.statusCode, 204, requestPath);
      assert.strictEqual(response.ended, true, requestPath);
      assert.strictEqual(
        response.headers["access-control-allow-origin"],
        "vscode-webview://dao-proxy-pro",
      );
      assert.strictEqual(
        response.headers["access-control-allow-private-network"],
        "true",
      );
      const allowed = String(
        response.headers["access-control-allow-headers"] || "",
      ).toLowerCase();
      for (const header of [
        "authorization",
        "content-type",
        "x-api-key",
        "x-goog-api-key",
        "anthropic-version",
      ]) {
        assert(allowed.includes(header), `${requestPath} missing ${header}`);
      }
    }
    // 恶意网页 origin 不得拿到 CORS / PNA
    {
      const request = {
        url: "/v1/chat/completions",
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "POST",
          "access-control-request-private-network": "true",
        },
      };
      const response = mockResponse();
      const handled = await origin._maybeRevproxy(request, response);
      assert.strictEqual(handled, true);
      assert.strictEqual(response.statusCode, 204);
      assert.strictEqual(
        response.headers["access-control-allow-origin"],
        undefined,
        "evil origin must not receive ACAO",
      );
      assert.strictEqual(
        response.headers["access-control-allow-private-network"],
        undefined,
        "evil origin must not receive PNA",
      );
    }
    console.log(`revproxy CORS selftest: PASS (${paths.length} protocols)`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
