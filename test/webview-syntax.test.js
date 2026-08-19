"use strict";

const assert = require("node:assert");
const vm = require("node:vm");
const { getEaConfigHtml } = require("../ui/ea-config-html");
const clientFiles = require("../ui/ea-config-client");

assert.deepStrictEqual(clientFiles, [
  "ea-config-client-core.js",
  "ea-config-client-models.js",
  "ea-config-client-revproxy.js",
  "ea-config-client-codex.js",
  "ea-config-client-codex-changes.js",
  "ea-config-client-observability.js",
  "ea-config-client-tunnel.js",
]);

// ⑨ 观测台
function assertObsPane(htmlText) {
  assert(htmlText.includes('data-pane="paneObs"'));
  assert(htmlText.includes('id="obsBadge"'));
  assert(htmlText.includes('id="obsAlerts"'));
  assert(htmlText.includes('id="obsFailures"'));
  assert(htmlText.includes('id="obsTraces"'));
  assert(htmlText.includes('id="obsAudit"'));
  assert(htmlText.includes('id="obsBackups"'));
  assert(htmlText.includes('id="obsExportPack"'));
  assert(htmlText.includes('id="obsImportPack"'));
}

const html = getEaConfigHtml(8919, "test-nonce", {});
assert.strictEqual(typeof html, "string");
assert(html.includes('data-pane="paneProtocolBridge"'));
assert(html.includes('<select id="pbSourceProtocol"></select>'));
assert(html.includes('<select id="pbSourceModel"></select>'));
assert(html.includes('id="pbDetect"'));
assert(html.includes('id="pbAccessKey"'));
assert(html.includes('id="pbAccessEndpoints"'));
assert(html.includes('id="pbTestRun"'));
assert(html.includes('id="pbTestAll"'));
assert(html.includes('id="pbClient"'));
assert(html.includes('id="pbClientConfig"'));
assert(html.includes('data-pane="paneCustomModel"'));
assert(html.includes('id="cmProvider"'));
assert(html.includes('id="cmUpstream"'));
assert(html.includes('id="cmUpstreamCustom"'));
assert(html.includes('id="cmReloadModels"'));
assert(html.includes('id="cmAddChannel"'));
assert(html.includes('id="cmCancelChannelEdit"'));
assert(html.includes('id="cmChannelList"'));
assert(html.includes('data-cm-channel-edit'));
assert(html.includes('id="cmRuntimeBanner"'));
assert(html.includes('当前实际使用'));
assert(html.includes('id="cmReasoning"'));
assert(html.includes('id="cmSave"'));
assert(html.includes('id="cmList"'));
assert(html.includes('id="routeReasoning"'));
assert(html.includes('id="routeDelete"'));
assert(html.includes('id="routeSharedModelNotice"'));
assert(html.includes('id="routeDetachShared"'));
assert(html.includes('id="rpTestReasoning"'));
assert(html.includes('id="pbReasoning"'));
assert(html.includes('data-pane="paneCodex"'));
assert(html.includes('id="codexProvider"'));
assert(html.includes('id="codexModel"'));
assert(html.includes('id="codexProtocol"'));
assert(html.includes('id="codexReasoning"'));
assert(html.includes('id="codexApply"'));
assert(html.includes('id="codexStatus"'));
assert(html.includes('id="codexObservedProvider"'));
assert(html.includes('id="codexObservedModel"'));
assert(html.includes('id="codexObservedReasoning"'));
assert(html.includes('id="codexObservedEndpoint"'));
assert(html.includes('id="codexPreservation"'));
assert(html.includes('data-codex-provider'));
assert(html.includes('_codexApplyProvider'));
assert(html.includes('id="codexChangesPhase"'));
assert(html.includes('id="codexChangesList"'));
assert(html.includes('id="codexChangesAcceptAll"'));
assert(html.includes('id="codexChangesRejectAll"'));
assert(html.includes("type: 'codexChangesGet'"));
assert(html.includes("_codexChangesPost('codexChangesOpen'"));
assert(html.includes('setInterval(_codexPoll, 3000)'));
assertObsPane(html);

const protocolPaneStart = html.indexOf('id="paneProtocolBridge"');
const customPaneStart = html.indexOf('id="paneCustomModel"');
const runtimeBanner = html.indexOf('id="cmRuntimeBanner"');
assert(protocolPaneStart >= 0 && customPaneStart > protocolPaneStart);
assert(
  runtimeBanner > customPaneStart,
  "current runtime model banner must belong to the custom-model pane",
);
assert.strictEqual(
  html.indexOf('id="cmRuntimeBanner"', runtimeBanner + 1),
  -1,
  "current runtime model banner must be rendered exactly once",
);

const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
assert(scripts.length > 0, "generated Webview contains no script");
for (let index = 0; index < scripts.length; index += 1) {
  new vm.Script(scripts[index][1], {
    filename: `generated-webview-${index + 1}.js`,
  });
}
assert(
  scripts.some((entry) => entry[1].includes("route.reasoningLevel || route.reasoningEffort")),
  "route editor must restore an explicitly saved reasoning effort",
);
assert(
  scripts.some((entry) => entry[1].includes("class=\"route-edit-btn\"")),
  "connected routes must expose a direct reasoning editor",
);
assert(
  scripts.some((entry) => entry[1].includes("var _routeSharedModelId = ''")),
  "route editor must track shared custom-model editing explicitly",
);
assert(
  scripts.some((entry) => entry[1].includes("fPost('/origin/ea/custom-model', customBody)")),
  "route editor must persist shared channel changes through the custom-model registry",
);
assert(
  scripts.some((entry) => entry[1].includes("同步渠道") && entry[1].includes("sourceChannels")),
  "reverse proxy and protocol bridge views must render synchronized custom-model channels",
);

console.log(`webview syntax selftest: PASS (${scripts.length} script, ${html.length} chars)`);
