const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Desktop Origin starts loopback-only and stops idempotently', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-origin-lifecycle-'));
  const configDir = path.join(root, 'config');
  const runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const configPath = path.join(configDir, '配置.json');
  const revproxyPath = path.join(configDir, 'revproxy.json');
  fs.writeFileSync(configPath, '{}\n', { mode: 0o600 });
  fs.writeFileSync(revproxyPath, '{"enabled":false}\n', { mode: 0o600 });

  const script = `
    const runtime = require('./vendor/外接api/runtime');
    const revproxy = require('./vendor/外接api/core/revproxy');
    runtime.configure({ configPath: ${JSON.stringify(configPath)} });
    revproxy.configure({ configPath: ${JSON.stringify(revproxyPath)} });
    const origin = require('./vendor/bundled-origin/source');
    (async () => {
      const started = await origin.start({
        host: '127.0.0.1',
        port: 0,
        mode: 'invert',
        profile: 'desktop',
        stateDir: ${JSON.stringify(runtimeDir)},
      });
      const running = origin.status();
      const lifecycle = origin._test._originLifecycleState();
      await origin.stop();
      await origin.stop();
      const stopped = origin.status();
      process.stdout.write('DAO_DESKTOP_RESULT=' + JSON.stringify({ started, running, lifecycle, stopped }) + '\\n');
      process.exit(0);
    })().catch((error) => {
      process.stderr.write(String(error && error.stack || error));
      process.exit(1);
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split('\n').find(value => value.startsWith('DAO_DESKTOP_RESULT='));
  assert.ok(line, result.stdout);
  const report = JSON.parse(line.slice('DAO_DESKTOP_RESULT='.length));
  assert.equal(report.started.profile, 'desktop');
  assert.equal(report.started.host, '127.0.0.1');
  assert.equal(report.running.running, true);
  assert.ok(Number.isInteger(report.running.port) && report.running.port > 0);
  assert.deepEqual(report.lifecycle, {
    profile: 'desktop',
    externalBridgeEnabled: false,
    pendingAutoConnect: false,
    codexConfigGuardEnabled: false,
  });
  assert.equal(report.stopped.running, false);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'endpoint.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'home', '.codeium', 'dao-byok', 'endpoint.json')), false);
});
