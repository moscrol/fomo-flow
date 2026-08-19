const fs = require('node:fs/promises');
const net = require('node:net');

const { writePrivateAtomic } = require('./dao_desktop_paths');

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function normalizeCandidates({ preferred = 8955, persisted, candidates = [] } = {}) {
  const values = [preferred, persisted, ...candidates];
  return values.filter(isValidPort).filter((value, index, list) => list.indexOf(value) === index);
}

function probeLoopbackPort(port, { host = '127.0.0.1', createServer = net.createServer } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (error, selectedPort) => {
      if (settled) return;
      settled = true;
      if (server.listening) {
        server.close(closeError => {
          if (error) reject(error);
          else if (closeError) reject(closeError);
          else resolve(selectedPort);
        });
        return;
      }
      if (error) reject(error);
      else resolve(selectedPort);
    };

    server.once('error', error => finish(error));
    server.listen(port, host, () => {
      const address = server.address();
      const selectedPort = address && typeof address === 'object' ? address.port : port;
      finish(null, selectedPort);
    });
  });
}

async function reserveDesktopPort(options = {}) {
  const candidates = normalizeCandidates(options);
  const probe = options.probe || probeLoopbackPort;

  for (const port of candidates) {
    try {
      return await probe(port, options);
    } catch (error) {
      if (!error || error.code !== 'EADDRINUSE') throw error;
    }
  }

  return probe(0, options);
}

async function readPersistedPort(portPath, { promises = fs } = {}) {
  try {
    const raw = await promises.readFile(portPath, 'utf8');
    const value = JSON.parse(raw);
    return value && isValidPort(value.port) ? value.port : null;
  } catch (_) {
    return null;
  }
}

async function writePersistedPort(portPath, port, deps = {}) {
  if (!isValidPort(port)) throw new Error('Expected a valid port between 1 and 65535');
  await writePrivateAtomic(
    portPath,
    `${JSON.stringify({ version: 1, port })}\n`,
    deps,
  );
}

module.exports = {
  isValidPort,
  normalizeCandidates,
  probeLoopbackPort,
  reserveDesktopPort,
  readPersistedPort,
  writePersistedPort,
};
