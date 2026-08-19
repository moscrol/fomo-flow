const path = require('node:path');

const {
  resolveDesktopPaths,
  prepareDesktopState,
  redactDesktopError,
} = require('./dao_desktop_paths');
const {
  readPersistedPort,
  reserveDesktopPort,
  writePersistedPort,
} = require('./dao_desktop_port');

function defaultConfigureExternal(paths, runtimeRoot) {
  const externalRuntime = require(path.join(runtimeRoot, 'vendor', '外接api', 'runtime.js'));
  externalRuntime.configure({ configPath: paths.configPath });
  return externalRuntime;
}

function defaultConfigureRevproxy(paths, runtimeRoot) {
  const revproxy = require(path.join(runtimeRoot, 'vendor', '外接api', 'core', 'revproxy.js'));
  revproxy.configure({ configPath: paths.revproxyPath });
  return revproxy;
}

function defaultLoadOrigin(runtimeRoot) {
  return require(path.join(runtimeRoot, 'vendor', 'bundled-origin', 'source.js'));
}

const DEFAULT_DEPS = {
  resolvePaths: resolveDesktopPaths,
  prepareState: prepareDesktopState,
  redactError: redactDesktopError,
  readPersistedPort,
  reservePort: reserveDesktopPort,
  writePersistedPort,
  configureExternal: defaultConfigureExternal,
  configureRevproxy: defaultConfigureRevproxy,
  loadOrigin: defaultLoadOrigin,
  startOrigin: (origin, options) => origin.start(options),
  stopOrigin: origin => origin && typeof origin.stop === 'function' ? origin.stop() : undefined,
};

function baseStatus() {
  return {
    healthy: false,
    running: false,
    port: null,
    url: null,
    profile: 'desktop',
    imported: { config: false, revproxy: false },
    error: null,
  };
}

function cloneStatus(status) {
  return {
    ...status,
    imported: { ...status.imported },
  };
}

class DaoDesktopRuntime {
  constructor({ userDataDir, homeDir, runtimeRoot, deps = {} } = {}) {
    this._runtimeRoot = path.resolve(runtimeRoot || path.join(__dirname, '..'));
    this._deps = { ...DEFAULT_DEPS, ...deps };
    this._paths = this._deps.resolvePaths({ userDataDir, homeDir });
    this._origin = null;
    this._startPromise = null;
    this._stopPromise = null;
    this._status = baseStatus();
  }

  status() {
    return cloneStatus(this._status);
  }

  async start() {
    if (this._status.healthy && this._status.running) return this.status();
    if (this._startPromise) return this._startPromise;

    this._startPromise = this._startOnce();
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async _startOnce() {
    let imported = { config: false, revproxy: false };
    try {
      const prepared = await this._deps.prepareState(this._paths);
      imported = prepared && prepared.imported ? { ...imported, ...prepared.imported } : imported;
      this._deps.configureExternal(this._paths, this._runtimeRoot);
      this._deps.configureRevproxy(this._paths, this._runtimeRoot);

      const persisted = await this._deps.readPersistedPort(this._paths.portPath);
      let port = await this._deps.reservePort({
        preferred: 8955,
        persisted,
        candidates: [8955, persisted].filter(Number.isInteger),
      });
      this._origin = this._deps.loadOrigin(this._runtimeRoot);

      let started;
      try {
        started = await this._deps.startOrigin(this._origin, this._originOptions(port));
      } catch (error) {
        if (!error || error.code !== 'EADDRINUSE') throw error;
        port = await this._deps.reservePort({ preferred: 0, candidates: [] });
        started = await this._deps.startOrigin(this._origin, this._originOptions(port));
      }

      const actualPort = Number.isInteger(started && started.port) ? started.port : port;
      if (!Number.isInteger(actualPort) || actualPort < 1 || actualPort > 65535) {
        throw new Error('Origin did not return a valid loopback port');
      }
      await this._deps.writePersistedPort(this._paths.portPath, actualPort);
      this._status = {
        healthy: true,
        running: true,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        profile: 'desktop',
        imported,
        error: null,
      };
      return this.status();
    } catch (error) {
      const message = this._deps.redactError(error);
      this._status = {
        ...baseStatus(),
        imported,
        error: message,
      };
      throw new Error(message);
    }
  }

  _originOptions(port) {
    return {
      host: '127.0.0.1',
      port,
      mode: 'invert',
      profile: 'desktop',
      stateDir: this._paths.runtimeDir,
    };
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = this._stopOnce();
    try {
      await this._stopPromise;
    } finally {
      this._stopPromise = null;
    }
  }

  async _stopOnce() {
    if (this._startPromise) {
      try {
        await this._startPromise;
      } catch (_) {}
    }
    const origin = this._origin;
    this._origin = null;
    if (origin) await this._deps.stopOrigin(origin);
    this._status = {
      ...this._status,
      healthy: false,
      running: false,
      port: null,
      url: null,
    };
  }
}

module.exports = {
  DaoDesktopRuntime,
  DEFAULT_DEPS,
};
