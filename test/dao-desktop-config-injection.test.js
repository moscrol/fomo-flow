const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtime = require('../vendor/外接api/runtime');
const revproxy = require('../vendor/外接api/core/revproxy');
const sweRouteGuard = require('../vendor/外接api/core/swe_route_guard');

test('runtime and reverse proxy accept explicit Desktop configuration paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-desktop-config-'));
  const configPath = path.join(root, 'config', '配置.json');
  const revproxyPath = path.join(root, 'config', 'revproxy.json');

  runtime.configure({ configPath });
  revproxy.configure({ configPath: revproxyPath });
  sweRouteGuard.configure({ configPath });

  assert.equal(runtime.getConfiguredConfigPath(), configPath);
  assert.equal(revproxy.getConfiguredConfigPath(), revproxyPath);
  assert.equal(revproxy._cfgPath(), revproxyPath);
  assert.deepEqual(sweRouteGuard.runtimePaths(), {
    configPath,
    guardPath: path.join(root, 'config', 'swe-route-guard.json'),
  });
});

test('configuration hooks can restore legacy resolution without touching process.env', () => {
  const original = process.env.DAO_BYOK_CONFIG;
  delete process.env.DAO_BYOK_CONFIG;
  try {
    runtime.configure();
    revproxy.configure();
    sweRouteGuard.configure();
    assert.equal(runtime.getConfiguredConfigPath(), null);
    assert.equal(revproxy.getConfiguredConfigPath(), null);
  } finally {
    if (original === undefined) delete process.env.DAO_BYOK_CONFIG;
    else process.env.DAO_BYOK_CONFIG = original;
  }
});

test('explicit paths survive the Origin runtime cache refresh', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-desktop-config-reload-'));
  const configPath = path.join(root, '配置.json');
  const modulePath = require.resolve('../vendor/外接api/runtime');
  runtime.configure({ configPath });
  delete require.cache[modulePath];
  const refreshed = require('../vendor/外接api/runtime');
  assert.equal(refreshed.getConfiguredConfigPath(), configPath);
  refreshed.configure();
});
