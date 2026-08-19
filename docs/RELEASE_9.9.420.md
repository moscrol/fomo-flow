# dao-proxy-pro 9.9.420

## Codex / Devin 文件差异双视图同步

本版解决 Codex 在 Devin 中修改文件后，VS Code Diff 与 Devin 绿色/红色差异使用不同基线、出现重复或内容不一致的问题。

### 统一事实源

- 模块⑧与 Devin 原生 SCM 共享同一个 `CodexChangeTracker`。
- 每个变更使用 `filePath + beforeHash + afterHash` 标识，状态包含新增、修改、删除、来源和磁盘校验结果。
- SCM Quick Diff 的原始文档来自捕获前快照，当前文档来自真实磁盘文件。
- 打开 Diff 前强制刷新当前文件，避免 watcher 防抖造成短暂旧视图。

### 安全行为

- Accept 只推进共享基线，不再次写文件。
- Reject 校验当前磁盘哈希和编辑器脏状态，发现后续编辑就阻止覆盖。
- 多个保存、创建、删除、重命名和外部监听事件合并为同一文件项。
- 不通过“先回滚、再应用 WorkspaceEdit”的方式伪造 ACP Diff，因此不会触发第二份代码或编辑循环。

### Devin 集成

安装并 Reload Window 后，Source Control 中会出现 `Codex / Devin 文件变更`。它与模块⑧同时显示同一批变更，并提供打开差异、接受和回退操作。Devin 自带的 Git/SVN SCM 仍保持原样。

日志已确认当前 `codex-acp` 自定义 Agent 被禁用；因此已有的 ACP/Cascade 轨迹不是本插件生成。本版同步的是 Devin 原生 SCM/DiffZone 文件审阅层，不修改或伪造历史工具调用轨迹。

## 验证

- Codex 热路由、Responses 与 compact 回归。
- tracker 修改/新增/删除、哈希、来源合并、Accept/Reject 回归。
- SCM Quick Diff、打开、接受、回退与资源刷新回归。
- 全量插件测试与 VSIX 打包校验。
