"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TEXT_EXTENSIONS = new Set([
  ".asmdef", ".asmref", ".asset", ".bat", ".c", ".cfg", ".cginc",
  ".cmd", ".cpp", ".cs", ".csproj", ".css", ".csv", ".dart", ".fs",
  ".fsproj", ".go", ".gradle", ".graphql", ".h", ".hpp", ".htm",
  ".html", ".ini", ".java", ".js", ".json", ".jsonc", ".jsx", ".kt",
  ".kts", ".less", ".lua", ".md", ".meta", ".mjs", ".mm", ".php",
  ".prefab", ".properties", ".proto", ".ps1", ".py", ".rb", ".rs",
  ".scss", ".shader", ".sh", ".sln", ".sql", ".svelte", ".swift",
  ".toml", ".ts", ".tsx", ".txt", ".unity", ".uss", ".uxml", ".vue",
  ".xml", ".yaml", ".yml",
]);

const TEXT_FILENAMES = new Set([
  ".editorconfig", ".gitattributes", ".gitignore", ".npmrc", ".prettierrc",
  ".stylelintrc", "dockerfile", "gemfile", "license", "makefile", "readme",
]);

const ROOT_GENERATED_DIRECTORIES = new Set([
  ".git", ".svn", ".vs", "Library", "Logs", "Temp",
]);

const ANY_DEPTH_GENERATED_DIRECTORIES = new Set([
  ".cache", ".idea", "__pycache__", "bin", "bower_components", "coverage",
  "node_modules", "obj",
]);

const DEFAULT_OPTIONS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxSnapshotBytes: 128 * 1024 * 1024,
  maxFiles: 30000,
  debounceMs: 140,
});

function normalizeAbsolute(value) {
  return path.resolve(String(value || "")).replace(/[\\/]+$/, "");
}

function pathKey(value) {
  const normalized = normalizeAbsolute(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function changeId(filePath) {
  return crypto.createHash("sha1").update(pathKey(filePath)).digest("hex");
}

function isInside(filePath, rootPath) {
  const file = pathKey(filePath);
  const root = pathKey(rootPath);
  return file === root || file.startsWith(root + path.sep);
}

function matchingRoot(filePath, roots) {
  return roots
    .filter((root) => isInside(filePath, root))
    .sort((left, right) => right.length - left.length)[0] || "";
}

function shouldSkipRelative(relativePath) {
  const parts = String(relativePath || "").split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return true;
  if (ROOT_GENERATED_DIRECTORIES.has(parts[0])) return true;
  return parts.some((part) => ANY_DEPTH_GENERATED_DIRECTORIES.has(part));
}

function isReviewableName(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(base);
}

function isProbablyText(buffer) {
  const length = Math.min(buffer.length, 8192);
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) return false;
  }
  return true;
}

function lineStats(beforeBuffer, afterBuffer) {
  const before = beforeBuffer ? beforeBuffer.toString("utf8").split(/\r?\n/) : [];
  const after = afterBuffer ? afterBuffer.toString("utf8").split(/\r?\n/) : [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  return {
    additions: Math.max(0, after.length - prefix - suffix),
    deletions: Math.max(0, before.length - prefix - suffix),
  };
}

async function readReviewableFile(filePath, options) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return { exists: false };
    throw error;
  }
  if (!stat.isFile()) return { exists: false };
  if (!isReviewableName(filePath)) return { exists: true, ignored: "unsupported" };
  if (stat.size > options.maxFileBytes) return { exists: true, ignored: "large", size: stat.size };
  const content = await fs.promises.readFile(filePath);
  if (!isProbablyText(content)) return { exists: true, ignored: "binary", size: stat.size };
  return { exists: true, content, hash: hashBuffer(content), size: stat.size };
}

class CodexChangeTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.phase = "idle";
    this.roots = [];
    this.baseline = new Map();
    this.changes = new Map();
    this.watchers = [];
    this.pendingTimers = new Map();
    this.pendingSources = new Map();
    this.indexingEvents = new Set();
    this.listeners = new Set();
    this.snapshotBytes = 0;
    this.snapshotFiles = 0;
    this.skippedFiles = 0;
    this.partial = false;
    this.warning = "";
    this.generation = 0;
    this.watcherFactory = options.watcherFactory || null;
    this.writeFile = options.writeFile || ((filePath, content) => fs.promises.writeFile(filePath, content));
    this.removeFile = options.removeFile || ((filePath) => fs.promises.unlink(filePath));
    this.canRestore = options.canRestore || (async () => true);
  }

  onDidChange(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  _emit() {
    const state = this.getState();
    for (const listener of this.listeners) {
      try { listener(state); } catch (_) {}
    }
  }

  async start(roots) {
    await this.reset();
    this.roots = Array.from(new Set((roots || []).map(normalizeAbsolute).filter(Boolean)));
    if (!this.roots.length) throw new Error("No file workspace is open in Devin");
    this.phase = "indexing";
    const generation = ++this.generation;
    this._installWatchers();
    this._emit();

    for (const root of this.roots) {
      await this._snapshotDirectory(root, root, generation);
      if (generation !== this.generation) return this.getState();
    }

    for (const filePath of this.indexingEvents) {
      this.baseline.set(pathKey(filePath), { unknown: true, filePath });
    }
    const queued = Array.from(this.indexingEvents);
    this.indexingEvents.clear();
    this.phase = "active";
    for (const filePath of queued) await this._processPath(filePath);
    this._emit();
    return this.getState();
  }

  async stop() {
    for (const watcher of this.watchers.splice(0)) {
      try { watcher.dispose(); } catch (_) {}
    }
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    this.pendingSources.clear();
    if (this.phase === "active" || this.phase === "indexing") this.phase = "stopped";
    this._emit();
    return this.getState();
  }

  async reset() {
    this.generation += 1;
    await this.stop();
    this.phase = "idle";
    this.roots = [];
    this.baseline.clear();
    this.changes.clear();
    this.indexingEvents.clear();
    this.snapshotBytes = 0;
    this.snapshotFiles = 0;
    this.skippedFiles = 0;
    this.partial = false;
    this.warning = "";
    this._emit();
  }

  dispose() {
    return this.reset();
  }

  _installWatchers() {
    if (!this.watcherFactory) return;
    for (const root of this.roots) {
      const watcher = this.watcherFactory(root, (filePath) => this.notifyPath(filePath));
      if (watcher) this.watchers.push(watcher);
    }
  }

  async _snapshotDirectory(root, directory, generation) {
    if (generation !== this.generation || this.partial) return;
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (generation !== this.generation || this.partial) return;
      const filePath = path.join(directory, entry.name);
      const relative = path.relative(root, filePath);
      if (shouldSkipRelative(relative)) continue;
      if (entry.isDirectory()) {
        await this._snapshotDirectory(root, filePath, generation);
        continue;
      }
      if (!entry.isFile() || !isReviewableName(filePath)) continue;
      const result = await readReviewableFile(filePath, this.options).catch(() => null);
      if (!result || !result.exists || result.ignored) {
        if (result && result.ignored) this.skippedFiles += 1;
        continue;
      }
      if (
        this.snapshotFiles + 1 > this.options.maxFiles ||
        this.snapshotBytes + result.content.length > this.options.maxSnapshotBytes
      ) {
        this.partial = true;
        this.warning = "Snapshot limit reached; only indexed files can be safely reverted";
        return;
      }
      this.baseline.set(pathKey(filePath), {
        filePath,
        root,
        content: result.content,
        hash: result.hash,
        exists: true,
      });
      this.snapshotFiles += 1;
      this.snapshotBytes += result.content.length;
    }
  }

  notifyPath(filePath, source = "filesystem") {
    const absolute = normalizeAbsolute(filePath);
    const root = matchingRoot(absolute, this.roots);
    if (!root || shouldSkipRelative(path.relative(root, absolute))) return;
    if (this.phase === "indexing") {
      this.indexingEvents.add(absolute);
      return;
    }
    if (this.phase !== "active") return;
    const key = pathKey(absolute);
    const sources = this.pendingSources.get(key) || new Set();
    sources.add(String(source || "filesystem"));
    this.pendingSources.set(key, sources);
    const oldTimer = this.pendingTimers.get(key);
    if (oldTimer) clearTimeout(oldTimer);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(key);
      this._processPath(absolute).catch(() => {});
    }, this.options.debounceMs);
    this.pendingTimers.set(key, timer);
  }

  async flush() {
    const paths = Array.from(this.pendingTimers.keys());
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    for (const key of paths) await this._processPath(key);
    return this.getState();
  }

  async _processPath(filePath) {
    const absolute = normalizeAbsolute(filePath);
    const root = matchingRoot(absolute, this.roots);
    if (!root) return;
    const key = pathKey(absolute);
    const pendingSources = this.pendingSources.get(key) || new Set();
    this.pendingSources.delete(key);
    const before = this.baseline.get(key);
    const after = await readReviewableFile(absolute, this.options).catch(() => null);
    if (!after) return;
    if (after.ignored) {
      this.changes.delete(key);
      this._emit();
      return;
    }
    const beforeExists = !!(before && before.exists && !before.unknown);
    const beforeHash = beforeExists ? before.hash : "";
    const afterExists = !!after.exists;
    const afterHash = afterExists ? after.hash : "";
    if (beforeExists === afterExists && beforeHash === afterHash) {
      this.changes.delete(key);
      this._emit();
      return;
    }
    const unknownBefore = !!(before && before.unknown);
    const stats = lineStats(beforeExists ? before.content : null, afterExists ? after.content : null);
    const status = unknownBefore ? "?" : !beforeExists ? "A" : !afterExists ? "D" : "M";
    const previous = this.changes.get(key);
    const sources = Array.from(new Set([
      ...((previous && previous.sources) || []),
      ...pendingSources,
    ])).sort();
    this.changes.set(key, {
      id: changeId(absolute),
      filePath: absolute,
      root,
      relativePath: path.relative(root, absolute).replace(/\\/g, "/"),
      status,
      beforeExists,
      beforeAvailable: !unknownBefore,
      beforeHash,
      afterExists,
      afterHash,
      fingerprint: `${beforeHash || "missing"}:${afterHash || "missing"}`,
      sources: sources.length ? sources : ["filesystem"],
      syncStatus: "disk-verified",
      additions: stats.additions,
      deletions: stats.deletions,
      observedAt: Date.now(),
    });
    this._emit();
  }

  _changeById(id) {
    for (const change of this.changes.values()) {
      if (change.id === id) return change;
    }
    return null;
  }

  getChangeByFilePath(filePath) {
    return this.changes.get(pathKey(filePath)) || null;
  }

  async refresh(id) {
    const change = this._changeById(id);
    if (!change) return this.getState();
    await this._processPath(change.filePath);
    return this.getState();
  }

  getBeforeContent(id) {
    const change = this._changeById(id);
    if (!change || !change.beforeExists) return "";
    const before = this.baseline.get(pathKey(change.filePath));
    return before && before.content ? before.content.toString("utf8") : "";
  }

  getAfterContent(id) {
    const change = this._changeById(id);
    if (!change || !change.afterExists) return "";
    try { return fs.readFileSync(change.filePath, "utf8"); } catch (_) { return ""; }
  }

  async accept(id) {
    const change = this._changeById(id);
    if (!change) throw new Error("Change no longer exists");
    const current = await readReviewableFile(change.filePath, this.options);
    const key = pathKey(change.filePath);
    if (current.exists && !current.ignored) {
      this.baseline.set(key, {
        filePath: change.filePath,
        root: change.root,
        content: current.content,
        hash: current.hash,
        exists: true,
      });
    } else {
      this.baseline.delete(key);
    }
    this.changes.delete(key);
    this._emit();
    return this.getState();
  }

  async reject(id) {
    const change = this._changeById(id);
    if (!change) throw new Error("Change no longer exists");
    if (!change.beforeAvailable) throw new Error("The file changed while the baseline was being created; restart capture to obtain a safe preimage");
    if (!(await this.canRestore(change.filePath))) throw new Error("The file has unsaved editor changes; save or discard them before reverting");
    const current = await readReviewableFile(change.filePath, this.options);
    const currentExists = !!current.exists;
    const currentHash = currentExists && !current.ignored ? current.hash : "";
    if (currentExists !== change.afterExists || currentHash !== change.afterHash) {
      throw new Error("The file changed after capture stopped; revert was blocked to protect newer edits");
    }
    const before = this.baseline.get(pathKey(change.filePath));
    if (change.beforeExists && before && before.content) {
      await this.writeFile(change.filePath, before.content);
    } else if (change.afterExists) {
      await this.removeFile(change.filePath);
    }
    this.changes.delete(pathKey(change.filePath));
    this._emit();
    return this.getState();
  }

  async acceptAll() {
    const ids = Array.from(this.changes.values()).map((change) => change.id);
    for (const id of ids) await this.accept(id);
    return { ok: ids.length, failed: [] };
  }

  async rejectAll() {
    const ids = Array.from(this.changes.values()).map((change) => change.id);
    const failed = [];
    let ok = 0;
    for (const id of ids) {
      try { await this.reject(id); ok += 1; }
      catch (error) { failed.push({ id, error: error && error.message ? error.message : String(error) }); }
    }
    return { ok, failed };
  }

  getState() {
    const changes = Array.from(this.changes.values())
      .map((change) => ({ ...change }))
      .sort((left, right) => right.observedAt - left.observedAt || left.relativePath.localeCompare(right.relativePath));
    return {
      phase: this.phase,
      active: this.phase === "active",
      indexing: this.phase === "indexing",
      roots: this.roots.slice(),
      snapshotFiles: this.snapshotFiles,
      snapshotBytes: this.snapshotBytes,
      skippedFiles: this.skippedFiles,
      partial: this.partial,
      warning: this.warning,
      changes,
      totals: changes.reduce((totals, change) => {
        totals.files += 1;
        totals.additions += change.additions;
        totals.deletions += change.deletions;
        return totals;
      }, { files: 0, additions: 0, deletions: 0 }),
    };
  }
}

module.exports = {
  CodexChangeTracker,
  DEFAULT_OPTIONS,
  changeId,
  hashBuffer,
  isProbablyText,
  isReviewableName,
  lineStats,
  matchingRoot,
  shouldSkipRelative,
};
