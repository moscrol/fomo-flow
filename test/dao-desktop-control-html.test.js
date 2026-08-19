const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getEaConfigHtml } = require('../ui/ea-config-html');

test('Desktop Dao Web HTML injects a nonce-bound narrow host bridge', () => {
  const html = getEaConfigHtml(9123, 'fixed-nonce', { desktop: true, foldBridge: true });

  assert.match(html, /<script nonce="fixed-nonce">/);
  assert.match(html, /data-port="9123"/);
  assert.match(html, /DAO_DESKTOP_CONTROL_BRIDGE/);
  assert.match(html, /openExternal/);
  assert.match(html, /openConfigJson/);
  assert.match(html, /copyHandoff/);
  assert.match(html, /saveHandoff/);
  assert.match(html, /var _FOLD = true/);
});

test('Desktop bridge is opt-in and does not replace VS Code webview behavior', () => {
  const html = getEaConfigHtml(9123, 'fixed-nonce');

  assert.doesNotMatch(html, /DAO_DESKTOP_CONTROL_BRIDGE/);
  assert.match(html, /acquireVsCodeApi/);
});
