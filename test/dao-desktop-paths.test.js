const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveDesktopPaths,
  prepareDesktopState,
  redactDesktopError,
} = require('../core/dao_desktop_paths');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-desktop-paths-'));
  return {
    root,
    home: path.join(root, 'home'),
    userData: path.join(root, 'user-data'),
  };
}

test('resolves Desktop paths from injected user-data and home directories', () => {
  const fixture = makeFixture();
  const paths = resolveDesktopPaths({
    userDataDir: fixture.userData,
    homeDir: fixture.home,
  });

  assert.equal(paths.root, fixture.userData);
  assert.equal(paths.configPath, path.join(fixture.userData, 'config', '配置.json'));
  assert.equal(paths.revproxyPath, path.join(fixture.userData, 'config', 'revproxy.json'));
  assert.equal(paths.portPath, path.join(fixture.userData, 'runtime', 'port.json'));
  assert.equal(paths.auditPath, path.join(fixture.userData, 'runtime', 'import-audit.json'));
  assert.equal(paths.legacyDir, path.join(fixture.home, '.codeium', 'dao-byok'));
  assert.equal(
    paths.legacyDesktopDir,
    path.join(fixture.home, 'Library', 'Application Support', 'Dao Flow'),
  );
});

test('defaults Application Support to FOMO FLOW when userDataDir is omitted', () => {
  const fixture = makeFixture();
  const paths = resolveDesktopPaths({ homeDir: fixture.home });
  assert.equal(
    paths.root,
    path.join(fixture.home, 'Library', 'Application Support', 'FOMO FLOW'),
  );
  assert.equal(paths.legacyDir, path.join(fixture.home, '.codeium', 'dao-byok'));
  assert.equal(
    paths.legacyDesktopDir,
    path.join(fixture.home, 'Library', 'Application Support', 'Dao Flow'),
  );
});

test('imports valid legacy configuration exactly once and preserves legacy bytes', async () => {
  const fixture = makeFixture();
  const legacyDir = path.join(fixture.home, '.codeium', 'dao-byok');
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyConfig = path.join(legacyDir, '配置.json');
  const legacyProxy = path.join(legacyDir, 'revproxy.json');
  const configBytes = '{"provider":"fixture","apiKey":"secret"}\n';
  const proxyBytes = '{"enabled":true}\n';
  fs.writeFileSync(legacyConfig, configBytes, { mode: 0o600 });
  fs.writeFileSync(legacyProxy, proxyBytes, { mode: 0o600 });
  const paths = resolveDesktopPaths({
    userDataDir: fixture.userData,
    homeDir: fixture.home,
  });

  const first = await prepareDesktopState(paths, {
    now: () => '2026-08-09T00:00:00.000Z',
  });
  assert.deepEqual(first.imported, { config: true, revproxy: true });
  assert.equal(fs.readFileSync(legacyConfig, 'utf8'), configBytes);
  assert.equal(fs.readFileSync(legacyProxy, 'utf8'), proxyBytes);
  assert.equal(fs.readFileSync(paths.configPath, 'utf8'), configBytes);
  assert.equal(fs.readFileSync(paths.revproxyPath, 'utf8'), proxyBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.auditPath, 'utf8')), {
    version: 1,
    importedAt: '2026-08-09T00:00:00.000Z',
    config: true,
    revproxy: true,
  });

  const second = await prepareDesktopState(paths);
  assert.deepEqual(second.imported, { config: false, revproxy: false });
  assert.equal(fs.readFileSync(paths.configPath, 'utf8'), configBytes);
});

test('does not import malformed legacy JSON and does not expose its path', async () => {
  const fixture = makeFixture();
  const legacyDir = path.join(fixture.home, '.codeium', 'dao-byok');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, '配置.json'), '{not-json', { mode: 0o600 });
  const paths = resolveDesktopPaths({
    userDataDir: fixture.userData,
    homeDir: fixture.home,
  });

  const result = await prepareDesktopState(paths);
  assert.deepEqual(result.imported, { config: false, revproxy: false });
  assert.deepEqual(result.warnings, ['legacy config JSON is invalid']);
  assert.equal(fs.existsSync(paths.configPath), false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('redacts secrets and absolute paths from errors', () => {
  const error = new Error('apiKey=secret token: bearer-token /Users/alice/.codeium/dao-byok/配置.json');
  const message = redactDesktopError(error);

  assert.match(message, /apiKey=\[redacted\]/);
  assert.match(message, /token: \[redacted\]/);
  assert.doesNotMatch(message, /secret|bearer-token|\/Users\/alice/);
});
