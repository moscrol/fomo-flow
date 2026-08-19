const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const builderConfig = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'electron-builder.yml'),
  'utf8',
);

test('Desktop packaging maps the runtime and HUD resources outside app.asar', () => {
  for (const mapping of [
    ['../core', 'dao-runtime/core'],
    ['../vendor', 'dao-runtime/vendor'],
    ['../ui', 'dao-runtime/ui'],
    ['../media', 'dao-runtime/media'],
  ]) {
    const [from, to] = mapping;
    assert.match(builderConfig, new RegExp(`from: ${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\s+to: ${to.replace('/', '\\/')}`));
  }
  assert.match(builderConfig, /asar: true/);
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'package.json'), 'utf8'));
  assert.match(packageJson.scripts['electron:package:dir'], /--arm64/);
  assert.match(packageJson.scripts['dist:mac'], /--arm64/);
});

test('Desktop packaging carries the complete FOMO FLOW control surface', () => {
  const uiFiles = fs.readdirSync(path.join(__dirname, '..', 'ui'));
  assert.ok(uiFiles.includes('ea-config-html.js'));
  assert.ok(uiFiles.includes('ea-config-client.js'));
  for (const file of require(path.join(__dirname, '..', 'ui', 'ea-config-client.js'))) {
    assert.ok(uiFiles.includes(file), `missing packaged FOMO FLOW client resource: ${file}`);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'electron', 'main.ts'), 'utf8'), /DAO_CONTROL_SCHEME/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'electron', 'preload.ts'), 'utf8'), /daoControlHost/);
});

test('Desktop primary workspace is native and lazy-loaded by capability', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'src', 'App.tsx'), 'utf8');
  for (const component of [
    'ProvidersControlView',
    'RoutesControlView',
    'RevproxyControlView',
    'TunnelControlView',
    'BridgesControlView',
    'CustomModelsControlView',
    'CodexControlView',
    'ObservabilityControlView',
  ]) {
    assert.match(appSource, new RegExp(`lazy\\(.*${component}`, 's'));
  }
  assert.doesNotMatch(appSource, /<HudView/);
  assert.match(appSource, /<Suspense/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'src', 'lib', 'desktopHost', 'index.ts'), 'utf8'), /requestControl/);
});

test('Desktop packaging excludes known local config and diagnostics from vendor resources', () => {
  assert.match(builderConfig, /!外接api\/core\/配置\.json/);
  assert.match(builderConfig, /!\*\*\/\*\.log/);
  assert.doesNotMatch(builderConfig, /from: \.\.\/test/);
  assert.doesNotMatch(builderConfig, /from: \.\.\/docs/);
});
