"use strict";

const assert = require("node:assert");

const {
  parseLoopbackEndpointDescriptor,
  selectDaoEndpoint,
} = require("../core/dao_local_endpoint.js");

assert.strictEqual(
  parseLoopbackEndpointDescriptor({
    base: "http://127.0.0.1:54500",
    host: "127.0.0.1",
    port: 54500,
  }),
  "http://127.0.0.1:54500",
);

for (const descriptor of [
  { base: "https://127.0.0.1:54500", host: "127.0.0.1", port: 54500 },
  { base: "http://localhost:54500", host: "localhost", port: 54500 },
  { base: "http://user@127.0.0.1:54500", host: "127.0.0.1", port: 54500 },
  { base: "http://127.0.0.1:54500/path", host: "127.0.0.1", port: 54500 },
  {
    base: "http://127.0.0.1:54500?token=secret",
    host: "127.0.0.1",
    port: 54500,
  },
  { base: "http://127.0.0.1:54500", host: "127.0.0.1", port: 8955 },
]) {
  assert.strictEqual(parseLoopbackEndpointDescriptor(descriptor), null);
}

(async () => {
  const probes = [];
  const probe = async (base) => {
    probes.push(base);
    return base !== "http://127.0.0.1:8937";
  };
  const descriptor = JSON.stringify({
    base: "http://127.0.0.1:54500",
    host: "127.0.0.1",
    port: 54500,
  });

  const explicit = await selectDaoEndpoint({
    explicitUrl: "http://127.0.0.1:60000",
    desktopDescriptorPath: "/fixed/desktop/endpoint.json",
    inheritedUrl: "http://127.0.0.1:8955",
    fallbackUrl: "http://127.0.0.1:8937",
    readFile: () => descriptor,
    probe,
  });
  assert.strictEqual(explicit, "http://127.0.0.1:60000");
  assert.deepStrictEqual(probes, ["http://127.0.0.1:60000"]);

  probes.length = 0;
  const desktop = await selectDaoEndpoint({
    desktopDescriptorPath: "/fixed/desktop/endpoint.json",
    inheritedUrl: "http://127.0.0.1:8955",
    fallbackUrl: "http://127.0.0.1:8937",
    readFile: () => descriptor,
    probe,
  });
  assert.strictEqual(desktop, "http://127.0.0.1:54500");
  assert.deepStrictEqual(probes, ["http://127.0.0.1:54500"]);

  probes.length = 0;
  const inherited = await selectDaoEndpoint({
    desktopDescriptorPath: "/fixed/desktop/endpoint.json",
    inheritedUrl: "http://127.0.0.1:8955",
    fallbackUrl: "http://127.0.0.1:8937",
    readFile: () => "not-json",
    probe,
  });
  assert.strictEqual(inherited, "http://127.0.0.1:8955");
  assert.deepStrictEqual(probes, ["http://127.0.0.1:8955"]);

  probes.length = 0;
  const unavailable = await selectDaoEndpoint({
    desktopDescriptorPath: "/fixed/desktop/endpoint.json",
    fallbackUrl: "http://127.0.0.1:8937",
    readFile: () => "not-json",
    probe,
  });
  assert.strictEqual(unavailable, "");
  assert.deepStrictEqual(probes, ["http://127.0.0.1:8937"]);

  console.log("dao local endpoint: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
