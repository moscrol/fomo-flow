"use strict";

const assert = require("node:assert");
const {
  createWorkspaceInputTransform,
  rewriteAuthenticateApiServerLine,
  rewriteSessionNewLine,
  workspaceRootsFromEnv,
} = require("../acp-workspace-message");

const WIN = process.platform === "win32";
const SEP = WIN ? "\\" : "/";
const ROOT = WIN ? "E:\\新增运行时状态机" : "/tmp/新增运行时状态机";
const OTHER_ROOT = WIN ? "E:\\另一个项目" : "/tmp/另一个项目";
const WRONG_CWD = WIN ? "C:\\temp" : "/tmp/wrong-temp";
const BAD_CWD = WIN ? "C:\\bad" : "/tmp/wrong-bad";

function parse(result) {
  return JSON.parse(result.line);
}

const missing = rewriteSessionNewLine(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { mcpServers: [] } }),
  [ROOT],
);
assert.equal(missing.changed, true);
assert.equal(parse(missing).params.cwd, ROOT);

const wrong = rewriteSessionNewLine(
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: WRONG_CWD, mcpServers: [] } }),
  [ROOT],
);
assert.equal(parse(wrong).params.cwd, ROOT);

const existingSubdirectory = rewriteSessionNewLine(
  JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: ROOT + SEP + "Assets", mcpServers: [] } }),
  [ROOT],
);
assert.equal(
  existingSubdirectory.changed,
  false,
  "a valid cwd inside the workspace must be preserved byte-for-byte",
);

const multiRoot = rewriteSessionNewLine(
  JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/new", params: { cwd: ROOT, mcpServers: [] } }),
  [ROOT, OTHER_ROOT],
);
assert.deepEqual(parse(multiRoot).params.additionalDirectories, [OTHER_ROOT]);

const inferred = rewriteSessionNewLine(
  JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/new", params: { cwd: ROOT, mcpServers: [] } }),
  [],
);
assert.equal(inferred.changed, true, "session/new cwd must register a workspace when env roots are absent");
assert.equal(parse(inferred).params.cwd, ROOT);
assert.deepEqual(parse(inferred).params.additionalDirectories, [ROOT]);

const unrelated = '{"jsonrpc":"2.0","id":5,"method":"initialize","params":{"x":1}}';
assert.equal(rewriteSessionNewLine(unrelated, [ROOT]).line, unrelated);
assert.equal(rewriteSessionNewLine("not-json", [ROOT]).line, "not-json");

const authenticated = rewriteAuthenticateApiServerLine(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 9,
    method: "authenticate",
    params: { meta: { api_key: "preserved", api_server_url: "https://api.devin.ai" } },
  }),
  "http://127.0.0.1:8955",
);
assert.equal(authenticated.changed, true);
assert.deepEqual(JSON.parse(authenticated.line).params.meta, {
  api_key: "preserved",
  api_server_url: "http://127.0.0.1:8955",
});

assert.deepEqual(
  workspaceRootsFromEnv({
    DAO_WORKSPACE_ROOT: ROOT,
    DAO_WORKSPACE_ROOTS: JSON.stringify([ROOT, OTHER_ROOT, ROOT]),
  }),
  [ROOT, OTHER_ROOT],
);

async function transformFragmentedInput() {
  const input = [
    unrelated,
    JSON.stringify({ jsonrpc: "2.0", id: 6, method: "session/new", params: { cwd: BAD_CWD, mcpServers: [] } }),
  ].join("\n") + "\n";
  const utf8 = Buffer.from(input, "utf8");
  const stream = createWorkspaceInputTransform([ROOT]);
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  for (let i = 0; i < utf8.length; i += 7) {
    stream.write(utf8.subarray(i, i + 7));
  }
  stream.end();
  await done;

  const lines = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n");
  assert.equal(lines[0], unrelated, "unrelated ACP messages must remain byte-identical");
  assert.equal(
    JSON.parse(lines[1]).params.cwd,
    ROOT,
    "fragmented session/new must be repaired",
  );
}

async function transformFragmentedAuthenticate() {
  const input = JSON.stringify({
    jsonrpc: "2.0",
    id: 10,
    method: "authenticate",
    params: { meta: { api_key: "preserved", api_server_url: "https://api.devin.ai" } },
  }) + "\n";
  const stream = createWorkspaceInputTransform([], undefined, "http://127.0.0.1:8955");
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const utf8 = Buffer.from(input, "utf8");
  for (let i = 0; i < utf8.length; i += 5) stream.write(utf8.subarray(i, i + 5));
  stream.end();
  await done;
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")).params.meta, {
    api_key: "preserved",
    api_server_url: "http://127.0.0.1:8955",
  });
}

async function transformInfersWorkspace() {
  const input = JSON.stringify({
    jsonrpc: "2.0",
    id: 8,
    method: "session/new",
    params: { cwd: ROOT, mcpServers: [] },
  }) + "\n";
  const stream = createWorkspaceInputTransform([]);
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  stream.end(input);
  await done;
  const params = JSON.parse(Buffer.concat(chunks).toString("utf8")).params;
  assert.equal(params.cwd, ROOT);
  assert.deepEqual(params.additionalDirectories, [ROOT]);
}

Promise.all([
  transformFragmentedInput(),
  transformFragmentedAuthenticate(),
  transformInfersWorkspace(),
])
  .then(() => console.log("acp workspace message selftest: PASS"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
