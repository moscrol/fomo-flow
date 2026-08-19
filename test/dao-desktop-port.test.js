const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const {
  reserveDesktopPort,
  readPersistedPort,
  writePersistedPort,
} = require('../core/dao_desktop_port');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test('prefers an available loopback candidate', async () => {
  const preferred = await freePort();
  const selected = await reserveDesktopPort({ preferred, candidates: [preferred] });
  assert.equal(selected, preferred);
});

test('falls back without touching an occupied listener', async () => {
  const blockedPort = await freePort();
  const fallbackPort = await freePort();
  const blocker = net.createServer();
  await listen(blocker, blockedPort);

  try {
    const selected = await reserveDesktopPort({
      preferred: blockedPort,
      candidates: [blockedPort, fallbackPort],
    });
    assert.equal(selected, fallbackPort);
    assert.equal(blocker.listening, true);
  } finally {
    await close(blocker);
  }
});

test('persists only valid ports', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-desktop-port-'));
  const portPath = path.join(root, 'runtime', 'port.json');

  await writePersistedPort(portPath, 8957);
  assert.equal(await readPersistedPort(portPath), 8957);
  await assert.rejects(writePersistedPort(portPath, 70000), /valid port/i);
  fs.writeFileSync(portPath, '{"port":"not-a-number"}\n');
  assert.equal(await readPersistedPort(portPath), null);
});
