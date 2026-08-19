const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PRODUCT, legacyStateDir } = require('./product_identity');

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

function resolveDesktopPaths({ userDataDir, homeDir = os.homedir() } = {}) {
  const root = path.resolve(
    userDataDir || path.join(homeDir, 'Library', 'Application Support', PRODUCT.desktopProductName),
  );
  const configDir = path.join(root, 'config');
  const runtimeDir = path.join(root, 'runtime');

  return {
    root,
    configDir,
    runtimeDir,
    configPath: path.join(configDir, '配置.json'),
    revproxyPath: path.join(configDir, 'revproxy.json'),
    portPath: path.join(runtimeDir, 'port.json'),
    auditPath: path.join(runtimeDir, 'import-audit.json'),
    logPath: path.join(runtimeDir, 'desktop.log'),
    legacyDir: legacyStateDir(homeDir),
    legacyDesktopDir: path.join(
      path.resolve(homeDir),
      'Library',
      'Application Support',
      PRODUCT.legacyDesktopName,
    ),
  };
}

function redactDesktopError(error) {
  const message = error && error.message ? error.message : String(error || 'Unknown error');
  return message
    .replace(
      /((?:api[_-]?key|authorization|token|password|secret)\s*(?:=|:)\s*)([^\s,;"']+)/gi,
      '$1[redacted]',
    )
    .replace(
      /((?:api[_-]?key|authorization|token|password|secret)\s*"?\s*:\s*")([^"]+)(")/gi,
      '$1[redacted]$3',
    )
    .replace(/(?:\/Users\/|\/home\/)[^\s"']+/g, '[path]')
    .replace(/~\/[\w./-]+/g, '[path]');
}

async function exists(filePath, promises) {
  try {
    await promises.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function writePrivateAtomic(filePath, value, { promises = fsp, randomBytes = crypto.randomBytes } = {}) {
  const directory = path.dirname(filePath);
  await promises.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const suffix = randomBytes(8).toString('hex');
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${suffix}.tmp`);
  let handle;

  try {
    handle = await promises.open(temporaryPath, 'wx', FILE_MODE);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await promises.rename(temporaryPath, filePath);
    await promises.chmod(filePath, FILE_MODE);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function copyFirstLegacyJsonIfMissing(sourcePaths, destinationPath, deps) {
  const { promises = fsp } = deps;
  if (await exists(destinationPath, promises)) return { imported: false, warning: null };
  let invalid = false;
  for (const sourcePath of sourcePaths.filter(Boolean)) {
    const result = await copyLegacyJsonIfMissing(sourcePath, destinationPath, deps);
    if (result.imported) return result;
    if (result.warning === 'invalid-json') invalid = true;
  }
  return { imported: false, warning: invalid ? 'invalid-json' : null };
}

async function copyLegacyJsonIfMissing(sourcePath, destinationPath, deps) {
  const { promises = fsp } = deps;
  if (await exists(destinationPath, promises)) return { imported: false, warning: null };
  if (!(await exists(sourcePath, promises))) return { imported: false, warning: null };

  let content;
  try {
    content = await promises.readFile(sourcePath, 'utf8');
    JSON.parse(content);
  } catch (_) {
    return { imported: false, warning: 'invalid-json' };
  }

  await writePrivateAtomic(destinationPath, content, deps);
  return { imported: true, warning: null };
}

async function prepareDesktopState(paths, deps = {}) {
  const promises = deps.promises || fsp;
  const now = deps.now || (() => new Date().toISOString());
  const writeDeps = { ...deps, promises };
  await promises.mkdir(paths.configDir, { recursive: true, mode: DIRECTORY_MODE });
  await promises.mkdir(paths.runtimeDir, { recursive: true, mode: DIRECTORY_MODE });
  await promises.chmod(paths.configDir, DIRECTORY_MODE).catch(() => {});
  await promises.chmod(paths.runtimeDir, DIRECTORY_MODE).catch(() => {});

  const config = await copyFirstLegacyJsonIfMissing(
    [
      paths.legacyDesktopDir && path.join(paths.legacyDesktopDir, 'config', '配置.json'),
      paths.legacyDir && path.join(paths.legacyDir, '配置.json'),
    ],
    paths.configPath,
    writeDeps,
  );
  const revproxy = await copyFirstLegacyJsonIfMissing(
    [
      paths.legacyDesktopDir && path.join(paths.legacyDesktopDir, 'config', 'revproxy.json'),
      paths.legacyDir && path.join(paths.legacyDir, 'revproxy.json'),
    ],
    paths.revproxyPath,
    writeDeps,
  );
  const imported = { config: config.imported, revproxy: revproxy.imported };
  const warnings = [];
  if (config.warning === 'invalid-json') warnings.push('legacy config JSON is invalid');
  if (revproxy.warning === 'invalid-json') warnings.push('legacy reverse-proxy JSON is invalid');

  if (imported.config || imported.revproxy) {
    await writePrivateAtomic(
      paths.auditPath,
      `${JSON.stringify({ version: 1, importedAt: now(), ...imported })}\n`,
      writeDeps,
    );
  }

  return { imported, warnings };
}

module.exports = {
  FILE_MODE,
  DIRECTORY_MODE,
  resolveDesktopPaths,
  redactDesktopError,
  writePrivateAtomic,
  prepareDesktopState,
};
