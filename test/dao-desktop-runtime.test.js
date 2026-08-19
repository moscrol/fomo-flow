const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DaoDesktopRuntime } = require('../core/dao_desktop_runtime');

test('starts dependencies in state/configuration/Origin order', async () => {
  const calls = [];
  const runtime = new DaoDesktopRuntime({
    userDataDir: '/tmp/dao-runtime-fixture',
    homeDir: '/tmp/dao-runtime-home',
    deps: {
      prepareState: async () => {
        calls.push('state');
        return { imported: { config: true, revproxy: false }, warnings: [] };
      },
      configureExternal: () => calls.push('external'),
      configureRevproxy: () => calls.push('revproxy'),
      readPersistedPort: async () => 8956,
      reservePort: async () => {
        calls.push('port');
        return 8955;
      },
      loadOrigin: () => ({ name: 'origin' }),
      startOrigin: async (_origin, options) => {
        calls.push('origin');
        assert.deepEqual(options, {
          host: '127.0.0.1',
          port: 8955,
          mode: 'invert',
          profile: 'desktop',
          stateDir: '/tmp/dao-runtime-fixture/runtime',
        });
        return { port: 8955, host: '127.0.0.1', profile: 'desktop', running: true };
      },
      writePersistedPort: async (_path, port) => {
        calls.push(`persist:${port}`);
      },
      stopOrigin: async () => calls.push('stop-origin'),
    },
  });

  const status = await runtime.start();
  assert.deepEqual(calls.slice(0, 5), ['state', 'external', 'revproxy', 'port', 'origin']);
  assert.equal(status.url, 'http://127.0.0.1:8955');
  assert.equal(status.healthy, true);
  assert.deepEqual(status.imported, { config: true, revproxy: false });
  assert.deepEqual(runtime.status(), status);

  await runtime.stop();
  assert.deepEqual(calls.slice(-1), ['stop-origin']);
  assert.equal(runtime.status().running, false);
});

test('memoizes concurrent start calls and redacts startup failures', async () => {
  let starts = 0;
  const runtime = new DaoDesktopRuntime({
    userDataDir: '/tmp/dao-runtime-failure',
    homeDir: '/tmp/dao-runtime-failure-home',
    deps: {
      prepareState: async () => ({ imported: { config: false, revproxy: false }, warnings: [] }),
      configureExternal: () => {},
      configureRevproxy: () => {},
      readPersistedPort: async () => null,
      reservePort: async () => 8955,
      loadOrigin: () => ({}),
      startOrigin: async () => {
        starts += 1;
        throw new Error('apiKey=hidden /Users/alice/private');
      },
      stopOrigin: async () => {},
    },
  });

  const [first, second] = await Promise.allSettled([runtime.start(), runtime.start()]);
  assert.equal(starts, 1);
  assert.equal(first.status, 'rejected');
  assert.equal(second.status, 'rejected');
  assert.match(first.reason.message, /apiKey=\[redacted\]/);
  assert.doesNotMatch(first.reason.message, /hidden|\/Users\/alice/);
  assert.deepEqual(runtime.status().imported, { config: false, revproxy: false });
  assert.equal(runtime.status().healthy, false);
  assert.doesNotMatch(JSON.stringify(runtime.status()), /hidden|\/Users\/alice/);
});

test('retries a port race with an ephemeral fallback without killing another process', async () => {
  const requestedPorts = [];
  let attempts = 0;
  const runtime = new DaoDesktopRuntime({
    userDataDir: '/tmp/dao-runtime-race',
    homeDir: '/tmp/dao-runtime-race-home',
    deps: {
      prepareState: async () => ({ imported: { config: false, revproxy: false }, warnings: [] }),
      configureExternal: () => {},
      configureRevproxy: () => {},
      readPersistedPort: async () => null,
      reservePort: async options => {
        requestedPorts.push(options.preferred);
        return options.preferred === 0 ? 49152 : 8955;
      },
      loadOrigin: () => ({}),
      startOrigin: async (_origin, options) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('address in use');
          error.code = 'EADDRINUSE';
          throw error;
        }
        return { port: options.port, host: '127.0.0.1', profile: 'desktop', running: true };
      },
      writePersistedPort: async () => {},
      stopOrigin: async () => {},
    },
  });

  const status = await runtime.start();
  assert.deepEqual(requestedPorts, [8955, 0]);
  assert.equal(status.port, 49152);
});
