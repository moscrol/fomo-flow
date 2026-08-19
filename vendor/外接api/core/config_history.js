/**
 * config_history.js · 配置历史 / 一键回滚 / 配置打包还原
 *   基于 dao_router 原子保存产生的 .config-backups 轮转备份 ·
 *   误改渠道/路由可回滚到任一历史版本 ·
 *   配置包(pack)可导出/导入 · 换电脑一条命令还原整套环境
 *
 * API:
 *   listBackups(configPath)            → [{name, at, size}] (新→旧)
 *   rollback(configPath, backupName)   → {ok, error?}
 *   exportPack(configPath)             → {ok, pack?, error?}
 *   importPack(configPath, pack)       → {ok, error?}
 */
"use strict";

const fs = require("fs");
const path = require("path");

const PACK_VERSION = 1;

function _backupDir(configPath) {
  return path.join(path.dirname(configPath), ".config-backups");
}

function listBackups(configPath) {
  try {
    const dir = _backupDir(configPath);
    if (!fs.existsSync(dir)) return [];
    const base = path.basename(configPath);
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base + ".") && f.endsWith(".bak"))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, at: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

function rollback(configPath, backupName) {
  try {
    const base = path.basename(configPath);
    const name = String(backupName || "");
    // 防路径穿越: 仅允许备份目录内的合法备份文件名
    if (
      !name.startsWith(base + ".") ||
      !name.endsWith(".bak") ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("..")
    ) {
      return { ok: false, error: "非法备份名" };
    }
    const bakPath = path.join(_backupDir(configPath), name);
    if (!fs.existsSync(bakPath)) return { ok: false, error: "备份不存在" };
    const data = fs.readFileSync(bakPath, "utf8");
    JSON.parse(data); // 校验备份是合法 JSON · 坏档不回滚
    // 回滚前先把「当前配置」也存一份备份 · 回滚本身亦可回滚
    if (fs.existsSync(configPath)) {
      try {
        const dir = _backupDir(configPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(configPath, path.join(dir, `${base}.${stamp}.bak`));
      } catch {}
    }
    // 原子写: 临时文件 → rename
    const tmp = `${configPath}.tmp-rollback-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, configPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function exportPack(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);
    return {
      ok: true,
      pack: {
        _packVersion: PACK_VERSION,
        _exportedAt: new Date().toISOString(),
        config: cfg,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function importPack(configPath, pack) {
  try {
    const p = typeof pack === "string" ? JSON.parse(pack) : pack;
    if (!p || typeof p !== "object") return { ok: false, error: "配置包为空" };
    const cfg = p.config && typeof p.config === "object" ? p.config : p;
    if (!cfg.providers && !cfg.daoRoutes) {
      return { ok: false, error: "配置包缺少 providers/daoRoutes" };
    }
    const data = JSON.stringify(cfg, null, 2);
    const tmp = `${configPath}.tmp-import-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, configPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { listBackups, rollback, exportPack, importPack, PACK_VERSION };
