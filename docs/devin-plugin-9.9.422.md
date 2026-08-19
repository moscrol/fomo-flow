# Devin 插件 9.9.422（缓存命中热修）

给已安装的 **道Agent Pro**（`dao-agi.dao-proxy-pro`，原 9.9.421）升级，让原生 Devin 窗口走 cccc 等 Anthropic 兼容中继时能读到 prompt cache。

这不是 Dao Flow App 的 `dao-flow` 扩展。身份仍是 `dao-proxy-pro`，装完会替换 Devin 里的旧插件。

## 改了什么

- `openai-compatible` 的 Anthropic 渠道同时发送 `x-api-key` 和 `Authorization: Bearer`
- 官方 `type=anthropic` 仍只发 `x-api-key`
- 路由层不再删除 Anthropic 请求的 Bearer
- 运行时锚点升为 `v9.9.422-dao-fa-zi-ran`，避免 Devin 复用旧进程

## 安装

安装包：仓库根目录 `dao-proxy-pro-9.9.422.vsix`

```bash
devin-desktop --install-extension dao-proxy-pro-9.9.422.vsix --force
```

或在 Devin 里：Extensions → Install from VSIX → 选这个文件 → **Reload Window**。

同一会话连续问两句（5 分钟内）。第二轮用量应出现 `cached > 0`。只有 `cacheWrite` 不算命中。

源码补丁（可打进 `linxiaoqi5111-del/devin-`）：`docs/devin-plugin-9.9.422.patch`
