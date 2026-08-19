# FOMO FLOW · Devin Local BYOK 完整交付包

这是 FOMO FLOW 的买家交付包，适用于 Devin Local 及其他兼容 VS Code 扩展的本地开发环境。

## 包内文件

- `fomo-flow-9.9.424.vsix`：插件安装包。
- `使用说明书-中文.md`：从安装到 Devin Local BYOK 的完整操作说明。
- `配置示例/`：Provider、模型反代和协议中转的无密钥示例。
- `LICENSE.txt`：许可证文本。
- `发行审计.txt`：本次交付包的文件与隐私检查结果。

## 三分钟开始

1. 在 Devin Local 的扩展管理中选择 **Install from VSIX**，安装 `fomo-flow-9.9.424.vsix`。
2. Reload Window 或完全重启 Devin Local。
3. 打开命令面板，运行 `FOMO FLOW: Provider and Route Settings`。
4. 添加你自己的 Provider、API Key 和上游模型。
5. 在模型路由中把 Devin 的模型 UID 绑定到该 Provider/模型，然后运行 `FOMO FLOW: Self Check`。
6. 回到 Devin，新建一条对话验证模型请求。

## 你需要自己准备

- Devin Local 或兼容的 VS Code-family 宿主。
- 一个或多个模型 Provider 的 API Key、Base URL 和真实模型名。
- Provider 侧的余额、配额和网络可达性。

本包不包含 API Key、模型额度、账号登录态，也不承诺任何第三方 Provider 的可用性。API Key 只应在你自己的电脑上填写，并妥善保管。

## 重要提醒

- 默认控制面和模型反代只监听本机回环地址。
- 只有在你明确需要时才开启局域网访问或公网隧道，并始终设置 API Key。
- 不要把 `~/.fomo-flow/配置.json`、`revproxy.json` 或包含密钥的导出包上传到公开位置。
- 出现无法连接、误路由或升级异常时，先运行 `FOMO FLOW: Restore Direct Connection` 恢复官方直连，再排查 Provider 配置。

完整步骤、配置字段和排障表见 `使用说明书-中文.md`。
