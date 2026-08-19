"use strict";

const assert = require("node:assert");
const { resolveAcpModelSessionId } = require("../acp-session-lineage");

const primaryKey = (sessionId) =>
  `windsurf.acp.session/summaryState/acp/devin-cli/${sessionId}`;
const summaryValue = (sessionId) =>
  JSON.stringify({ prefixedSessionId: `acp/summary-agent/${sessionId}` });

assert.equal(
  resolveAcpModelSessionId("acp/summary-agent/atlantic-clarinet", {
    readRows: () => [
      {
        key: primaryKey("painted-paper"),
        value: summaryValue("atlantic-clarinet"),
      },
    ],
  }),
  "painted-paper",
  "a summary agent must resolve to its explicitly linked primary ACP session",
);

assert.equal(
  resolveAcpModelSessionId("acp/summary-agent/unlinked", { readRows: () => [] }),
  "acp/summary-agent/unlinked",
  "an unlinked summary agent must not inherit another Space's model",
);

assert.equal(
  resolveAcpModelSessionId("acp/summary-agent/shared", {
    readRows: () => [
      { key: primaryKey("space-a"), value: summaryValue("shared") },
      { key: primaryKey("space-b"), value: summaryValue("shared") },
    ],
  }),
  "acp/summary-agent/shared",
  "ambiguous ownership must not pick a Space model",
);

assert.equal(
  resolveAcpModelSessionId("primary-session", { readRows: () => [] }),
  "primary-session",
  "a primary session must remain its own model key",
);

console.log("acp session lineage selftest: PASS");
