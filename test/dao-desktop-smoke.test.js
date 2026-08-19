const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Desktop runtime serves the existing HUD and releases its loopback listener', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-desktop-smoke-'));
  const script = `
    const { DaoDesktopRuntime } = require('./core/dao_desktop_runtime');
    (async () => {
      const runtime = new DaoDesktopRuntime({
        userDataDir: ${JSON.stringify(path.join(root, 'user-data'))},
        homeDir: ${JSON.stringify(path.join(root, 'home'))},
        runtimeRoot: process.cwd(),
      });
      const status = await runtime.start();
      const configuredPath = require('./vendor/外接api/runtime').getConfiguredConfigPath();
      const hud = await fetch(status.url + '/hud');
      const snapshot = await fetch(status.url + '/origin/hud/snapshot');
      const revproxyStatus = await fetch(status.url + '/origin/revproxy/status');
      const revproxyPayload = await revproxyStatus.json();
      const tasks = await fetch(status.url + '/origin/tasks', {
        headers: { Authorization: 'Bearer ' + revproxyPayload.apiKey },
      });
      const routingDecisions = await fetch(status.url + '/origin/ea/routing-decisions?profile=cheap&limit=2');
      const preflightInvalid = await fetch(status.url + '/origin/ea/route-preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'PROMPT_SENTINEL' }),
      });
      const decisionInbox = await fetch(status.url + '/origin/ea/decision-inbox?limit=20');
      const routeEvidence = await fetch(status.url + '/origin/ea/route-evidence?limit=20');
      const html = await hud.text();
      const payload = await snapshot.json();
      const taskPayload = await tasks.json();
      const routingDecisionPayload = await routingDecisions.json();
      const decisionInboxPayload = await decisionInbox.json();
      const routeEvidencePayload = await routeEvidence.json();
      await runtime.stop();
      process.stdout.write('DAO_DESKTOP_SMOKE=' + JSON.stringify({
        status,
        configuredPath,
        hud: hud.status,
        marker: html.includes('data-screen-label="FOMO FLOW HUD"'),
        snapshot: snapshot.status,
        snapshotObject: !!payload && typeof payload === 'object',
        tasks: tasks.status,
        tasksObject: !!taskPayload && typeof taskPayload === 'object' && taskPayload.ok === true,
        routingDecisions: routingDecisions.status,
        routingDecisionEnvelope:
          !!routingDecisionPayload &&
          typeof routingDecisionPayload === 'object' &&
          routingDecisionPayload.ok === true &&
          Array.isArray(routingDecisionPayload.decisions),
        preflightInvalid: preflightInvalid.status,
        decisionInbox: decisionInbox.status,
        decisionInboxEnvelope:
          decisionInboxPayload.ok === true && Array.isArray(decisionInboxPayload.items),
        routeEvidence: routeEvidence.status,
        routeEvidenceEnvelope:
          routeEvidencePayload.ok === true && Array.isArray(routeEvidencePayload.evidence),
        stopped: runtime.status(),
      }) + '\\n');
      process.exit(0);
    })().catch(error => {
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
  const line = result.stdout.split('\n').find(value => value.startsWith('DAO_DESKTOP_SMOKE='));
  assert.ok(line, result.stdout);
  const report = JSON.parse(line.slice('DAO_DESKTOP_SMOKE='.length));
  assert.equal(report.status.healthy, true);
  assert.equal(report.configuredPath, path.join(root, 'user-data', 'config', '配置.json'));
  assert.match(report.status.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(report.hud, 200);
  assert.equal(report.marker, true);
  assert.equal(report.snapshot, 200);
  assert.equal(report.snapshotObject, true);
  assert.equal(report.tasks, 200);
  assert.equal(report.tasksObject, true);
  assert.equal(report.routingDecisions, 200);
  assert.equal(report.routingDecisionEnvelope, true);
  assert.equal(report.preflightInvalid, 400);
  assert.equal(report.decisionInbox, 200);
  assert.equal(report.decisionInboxEnvelope, true);
  assert.equal(report.routeEvidence, 200);
  assert.equal(report.routeEvidenceEnvelope, true);
  assert.equal(report.stopped.running, false);
  assert.equal(fs.existsSync(path.join(root, 'user-data', 'runtime', 'endpoint.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'user-data', 'config', '配置.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'home', '.codeium', 'dao-byok', 'endpoint.json')), false);
});

test('Legacy Dao Web control surface remains an isolated compatibility fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-desktop-control-smoke-'));
  const script = `
    const { DaoDesktopRuntime } = require('./core/dao_desktop_runtime');
    const { getCheckedEaConfigHtml } = require('./ui/ea-config-html');
    (async () => {
      const runtime = new DaoDesktopRuntime({
        userDataDir: ${JSON.stringify(path.join(root, 'user-data'))},
        homeDir: ${JSON.stringify(path.join(root, 'home'))},
        runtimeRoot: process.cwd(),
      });
      const status = await runtime.start();
      const html = getCheckedEaConfigHtml(status.port, 'desktop-smoke-nonce', { desktop: true, foldBridge: true });
      const overview = await fetch(status.url + '/origin/ea/overview');
      await runtime.stop();
      process.stdout.write('DAO_DESKTOP_CONTROL_SMOKE=' + JSON.stringify({
        htmlStatus: html.includes('DAO_DESKTOP_CONTROL_BRIDGE'),
        nonce: html.includes('nonce="desktop-smoke-nonce"'),
        tabs: ['paneEssence', 'paneProvider', 'paneRouter', 'paneRevproxy', 'paneBridge', 'paneProtocolBridge', 'paneCustomModel', 'paneCodex', 'paneObs'].every(id => html.includes('id="' + id + '"')),
        overview: overview.status,
      }) + '\\n');
      process.exit(0);
    })().catch(error => {
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
  const line = result.stdout.split('\n').find(value => value.startsWith('DAO_DESKTOP_CONTROL_SMOKE='));
  assert.ok(line, result.stdout);
  const report = JSON.parse(line.slice('DAO_DESKTOP_CONTROL_SMOKE='.length));
  assert.equal(report.htmlStatus, true);
  assert.equal(report.nonce, true);
  assert.equal(report.tabs, true);
  assert.equal(report.overview, 200);
});
