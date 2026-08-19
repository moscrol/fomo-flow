"use strict";

const http = require("http");
const router = require("./dao_router");

let failures = 0;
function check(name, value) {
  if (value) console.log("  ✓ " + name);
  else {
    failures++;
    console.error("  ✗ " + name);
  }
}

function request(port, agent) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", agent },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(Number(body)));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const server = http.createServer((req, res) => {
    res.end(String(req.socket.remotePort));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const target = new URL(`http://127.0.0.1:${port}/v1/chat/completions`);
  const firstAgent = router._test.getAffinityAgent(false, target, "balanced", "dao:cascade-a");
  const sameAgent = router._test.getAffinityAgent(false, target, "balanced", "dao:cascade-a");
  const otherAgent = router._test.getAffinityAgent(false, target, "balanced", "dao:cascade-b");
  check("同一 Cascade 复用同一 Agent", firstAgent === sameAgent);
  check("不同 Cascade 隔离连接池", firstAgent !== otherAgent);
  const firstPort = await request(port, firstAgent);
  const secondPort = await request(port, sameAgent);
  check("连续请求复用同一 TCP 连接", firstPort === secondPort);
  for (let index = 0; index < 80; index++)
    router._test.getAffinityAgent(false, target, "balanced", `dao:session-${index}`);
  check("连接亲和池有界", router._test.affinityAgentCount() <= 64);
  server.close();
  console.log(failures ? `\n${failures} FAIL` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
