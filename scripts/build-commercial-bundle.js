#!/usr/bin/env node
"use strict";

/*
 * Build a buyer-facing FOMO FLOW bundle from the current working tree.
 * The staging tree is intentionally allowlisted; it is not a copy of the repo.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const yazl = require("yazl");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(packageJson.version || "0.0.0");
const distRoot = path.join(root, "dist");
const bundleName = `dao-flow-${version}-complete-bundle`;
const bundleDir = path.join(distRoot, bundleName);
const stageDir = path.join(distRoot, ".dao-flow-staging");
const vsixName = `dao-flow-${version}.vsix`;
const vsixPath = path.join(bundleDir, vsixName);
const zipPath = path.join(bundleDir, `${bundleName}.zip`);
const auditPath = path.join(bundleDir, "发行审计.txt");
const vsixAuditDir = path.join(distRoot, ".dao-flow-vsix-audit");

const rootRuntimeFiles = [
  "extension.js",
  "workspace_ignore_guard.js",
  "dao-acp-stdio-proxy.js",
  "acp-workspace-message.js",
  "acp-session-lineage.js",
  "acp-session-bridge.js",
  "LICENSE.txt",
];

const bundledOriginFiles = [
  "source.js",
  "team-settings-cache.js",
  "prompt_studio.html",
  "_silk_de.txt",
  "_silk_dao.txt",
  "_yinfu.txt",
  "_windows_agent.txt",
  "_kicad_agent.txt",
  "_freecad_agent.txt",
  "_dao_81.txt",
  "_full_model_catalog.json",
];

const selectedScripts = ["dao-reset.sh", "dao-reset.ps1", "dao-mcp-server.js"];
const excludedExternalCore = new Set([
  "dao-test.js",
  "lsp_mock_server.js",
  "lsp_scenarios.js",
  "lsp_sim_run.js",
  "lsp_simulator.js",
  "lsp_tools.js",
]);

const privatePatterns = [
  /github\.com\/dao-genesis/i,
  /windsurf-assistant/i,
  /\/Users\/a77\/dao-proxy-pro/i,
  /zhouyoukang/i,
];
const credentialPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{24,}\b/,
  /Bearer\s+[A-Za-z0-9._-]{24,}/i,
];
const textExtensions = new Set([
  ".css", ".html", ".js", ".json", ".md", ".ps1", ".sh", ".svg", ".txt",
  ".xml", ".yaml", ".yml",
]);

function assertSafeOutput(target) {
  const resolved = path.resolve(target);
  const allowed = path.resolve(distRoot) + path.sep;
  if (!resolved.startsWith(allowed)) {
    throw new Error(`Refusing to remove path outside dist/: ${resolved}`);
  }
}

function removeOutput(target) {
  assertSafeOutput(target);
  fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
}

function copyFile(relativeSource, relativeTarget = relativeSource) {
  const source = path.join(root, relativeSource);
  const target = path.join(stageDir, relativeTarget);
  if (!fs.existsSync(source)) return false;
  ensureDir(target);
  fs.copyFileSync(source, target);
  return true;
}

function copyDirectory(relativeSource, relativeTarget = relativeSource) {
  const source = path.join(root, relativeSource);
  const target = path.join(stageDir, relativeTarget);
  if (!fs.existsSync(source)) return false;
  fs.cpSync(source, target, { recursive: true, force: true });
  return true;
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function sanitizeExtensionSource() {
  const target = path.join(stageDir, "extension.js");
  let source = fs.readFileSync(target, "utf8");
  source = source
    .replace(/c:\\Users\\zhouyoukang\\extensions/gi, "c:\\Users\\<user>\\extensions")
    .replace(/\/Users\/a77\/dao-proxy-pro/gi, "<local-extension-path>");
  fs.writeFileSync(target, source, "utf8");
}

function writeSanitizedManifest() {
  const manifest = JSON.parse(JSON.stringify(packageJson));
  for (const key of ["repository", "homepage", "bugs", "funding", "scripts", "devDependencies", "__metadata"]) {
    delete manifest[key];
  }
  fs.writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function writeStagedIgnore() {
  const contents = [
    "*.vsix",
    ".git*",
    "test/**",
    "docs/**",
    "release-assets/**",
    "dist/**",
    "**/*.log",
    "**/*_dump.json",
    "**/*_diag.log",
    "vendor/外接api/core/配置.json",
    "vendor/bundled-origin/源.js",
    "vendor/bundled-origin/_origin_mode.txt",
    "vendor/bundled-origin/_origin_canon.txt",
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(stageDir, ".vscodeignore"), contents, "utf8");
}

function stageRuntime() {
  fs.mkdirSync(stageDir, { recursive: true });
  for (const file of rootRuntimeFiles) copyFile(file);
  copyFile("package.json");
  for (const directory of ["core", "ui", "media"]) copyDirectory(directory);

  const originTarget = path.join(stageDir, "vendor", "bundled-origin");
  fs.mkdirSync(originTarget, { recursive: true });
  for (const file of bundledOriginFiles) copyFile(path.join("vendor", "bundled-origin", file));

  const externalTarget = path.join(stageDir, "vendor", "外接api");
  fs.mkdirSync(externalTarget, { recursive: true });
  copyFile(path.join("vendor", "外接api", "runtime.js"));
  copyFile(path.join("vendor", "外接api", "core", "_默认配置.json"));
  copyFile(path.join("vendor", "外接api", "core", "revproxy_console.html"));
  const externalCore = path.join(root, "vendor", "外接api", "core");
  for (const file of fs.readdirSync(externalCore)) {
    if (!file.endsWith(".js") || file.startsWith("_") || excludedExternalCore.has(file)) continue;
    copyFile(path.join("vendor", "外接api", "core", file));
  }

  const scriptTarget = path.join(stageDir, "scripts");
  fs.mkdirSync(scriptTarget, { recursive: true });
  for (const file of selectedScripts) copyFile(path.join("scripts", file));

  const buyerReadme = path.join(root, "release-assets", "README-先看这里.md");
  fs.copyFileSync(buyerReadme, path.join(stageDir, "README.md"));
  writeSanitizedManifest();
  sanitizeExtensionSource();
  writeStagedIgnore();
}

function textFilesUnder(directory) {
  return walkFiles(directory).filter((file) => textExtensions.has(path.extname(file).toLowerCase()));
}

function scanText(label, files, readText) {
  const findings = [];
  for (const file of files) {
    const text = readText(file);
    for (const pattern of privatePatterns) {
      if (pattern.test(text)) findings.push(`${label}: ${path.basename(file)} matches ${pattern}`);
    }
    for (const pattern of credentialPatterns) {
      if (pattern.test(text)) findings.push(`${label}: ${path.basename(file)} matches credential pattern`);
    }
  }
  return findings;
}

function listZipEntries(zipFile) {
  return execFileSync("unzip", ["-Z1", zipFile], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function auditArtifacts() {
  const stagedTextFiles = textFilesUnder(stageDir);
  const findings = scanText("staging", stagedTextFiles, (file) => fs.readFileSync(file, "utf8"));
  const vsixEntries = listZipEntries(vsixPath);
  const forbiddenEntryPatterns = [
    /^extension\/(?:test|docs|release-assets)\//i,
    /(?:^|\/)\.git/i,
    /\.vsix$/i,
    /(?:_dump|_diag|selftest)/i,
    /(?:^|\/)配置\.json$/,
    /(?:^|\/)源\.js$/,
  ];
  const forbiddenEntries = vsixEntries.filter((entry) => forbiddenEntryPatterns.some((pattern) => pattern.test(entry)));
  if (forbiddenEntries.length) findings.push(`VSIX contains excluded entries: ${forbiddenEntries.join(", ")}`);

  removeOutput(vsixAuditDir);
  fs.mkdirSync(vsixAuditDir, { recursive: true });
  try {
    execFileSync("unzip", ["-q", vsixPath, "-d", vsixAuditDir], { stdio: "inherit" });
    const extractedExtension = path.join(vsixAuditDir, "extension");
    const manifest = JSON.parse(fs.readFileSync(path.join(extractedExtension, "package.json"), "utf8"));
    for (const key of ["repository", "homepage", "bugs", "funding"]) {
      if (Object.prototype.hasOwnProperty.call(manifest, key)) findings.push(`VSIX manifest retains ${key}`);
    }
    findings.push(...scanText("vsix", textFilesUnder(extractedExtension), (file) => fs.readFileSync(file, "utf8")));
  } finally {
    removeOutput(vsixAuditDir);
  }

  if (findings.length) throw new Error(`Privacy/artifact audit failed:\n${findings.join("\n")}`);
  return { stagedFiles: walkFiles(stageDir).length, vsixEntries: vsixEntries.length };
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeAudit({ stagedFiles, vsixEntries, zipBytes }) {
  const vsixBytes = fs.statSync(vsixPath).size;
  const text = [
    "FOMO FLOW 完整交付包发行审计",
    `版本: ${version}`,
    `VSIX 文件: ${vsixName}`,
    `VSIX 文件数: ${vsixEntries}`,
    `VSIX 大小字节: ${vsixBytes}`,
    `完整 ZIP 大小字节: ${zipBytes || "待归档后确认"}`,
    `构建树文件数: ${stagedFiles}`,
    "排除检查: 测试、内部文档、诊断日志、转储、历史 VSIX、运行时配置状态 = 已排除",
    "清理检查: 扩展仓库地址、主机路径、个人用户名、真实凭据 = 未发现",
    `VSIX SHA-256: ${sha256(vsixPath)}`,
    "说明: 这是针对本次交付文件的静态检查，不替代买家侧 Provider 连通性测试。",
    "",
  ].join("\n");
  fs.writeFileSync(auditPath, text, "utf8");
}

function createZip() {
  removeOutput(zipPath);
  const files = walkFiles(bundleDir)
    .filter((file) => path.resolve(file) !== path.resolve(zipPath))
    .map((file) => path.relative(bundleDir, file));
  if (!files.length) throw new Error("No buyer files available for ZIP");
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(zipPath);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    output.once("error", fail);
    zip.outputStream.once("error", fail);
    output.once("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    for (const file of files) zip.addFile(path.join(bundleDir, file), file);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

async function main() {
  removeOutput(stageDir);
  removeOutput(bundleDir);
  fs.mkdirSync(distRoot, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  stageRuntime();
  fs.mkdirSync(bundleDir, { recursive: true });
  const vsce = path.join(root, "node_modules", ".bin", "vsce");
  if (!fs.existsSync(vsce)) throw new Error("Missing node_modules/.bin/vsce; run npm install first");
  execFileSync(vsce, ["package", "--no-dependencies", "--allow-missing-repository", "--out", vsixPath], {
    cwd: stageDir,
    stdio: "inherit",
  });

  const buyerFiles = [
    ["README-先看这里.md", "README-先看这里.md"],
    ["使用说明书-中文.md", "使用说明书-中文.md"],
    ["配置示例", "配置示例"],
    ["LICENSE.txt", "LICENSE.txt", path.join(root, "LICENSE.txt")],
  ];
  for (const [source, target, explicitSource] of buyerFiles) {
    const sourcePath = explicitSource || path.join(root, "release-assets", source);
    const targetPath = path.join(bundleDir, target);
    if (fs.statSync(sourcePath).isDirectory()) fs.cpSync(sourcePath, targetPath, { recursive: true });
    else { ensureDir(targetPath); fs.copyFileSync(sourcePath, targetPath); }
  }

  const audit = auditArtifacts();
  let zipBytes = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    writeAudit({ ...audit, zipBytes });
    await createZip();
    const actual = fs.statSync(zipPath).size;
    if (actual === zipBytes) break;
    zipBytes = actual;
  }
  writeAudit({ ...audit, zipBytes: fs.statSync(zipPath).size });
  await createZip();
  removeOutput(stageDir);
  console.log(`Built ${vsixPath}`);
  console.log(`Built ${zipPath}`);
  console.log(`Audit ${auditPath}`);
}

Promise.resolve(main()).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
