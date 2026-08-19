# Devin 插件 Anthropic 缓存热修设计

## 目标

让当前 Devin 会话通过 `cccc` 渠道复用 Anthropic 提示缓存。成功标准是同一会话的后续真实请求仍按既定优先级走 `cccc / claude-opus-5`，并在 Dao Flow 用量事实中出现大于零的 `cache_read`/`cached`。

## 已确认事实

- `cccc` 已且仅已从 `openai-chat` 切换为 `anthropic`，完成路径为 `/v1/messages`。
- 恢复会话后的请求处于 `explicit`、`5m` 缓存模式，并持续产生缓存写入，但缓存读取为零。
- 同一请求在源码运行时使用 `x-api-key` 与 `Authorization: Bearer` 双鉴权时可在第二次请求读到缓存。
- 已安装的 Devin 插件 9.9.423 仍只发送 `x-api-key`，且路由层会删除 `Authorization`。

## 方案

只对已安装插件做两处与源码相同的最小热修：

1. Anthropic 适配器继续发送 `x-api-key`；当渠道类型是 `openai-compatible` 时，同时发送 `Authorization: Bearer`。
2. 路由层不再无条件删除 Anthropic 请求的 `Authorization`。

协议仍为 `anthropic`，provider、model、priority、缓存 TTL、会话内容和插件观测台均不改变。

## 安全与恢复

- 修改前将两个插件文件复制到带时间戳、权限为 700 的本地备份目录。
- 不打印、复制或新增持久化 API key、prompt、Authorization 值及原始 session ID。
- 补丁只作用于本机已安装插件；源码已有同等修复及回归测试。
- 若插件启动失败或请求失败，恢复两个备份文件并重新启动 Devin。

## 验证

1. 静态检查插件的 Anthropic 适配器包含渠道类型判断，路由层不再删除 Authorization。
2. 重启 Devin 插件运行时，确认 `/origin/health` 恢复。
3. 在当前恢复的 Devin 会话发送连续、普通的短续问。
4. 读取 `/origin/ea/usage` 的安全统计字段，确认请求仍走 cccc 且至少一笔 `cached > 0`。
5. 若首笔只写缓存，允许在 5 分钟窗口内发送第二笔；不得把缓存写入冒充缓存命中。

## 非目标

- 不重构或整体替换插件。
- 不调整路由优先级或自动切换 provider/model。
- 不修改 Devin 会话内容、系统提示词或工具列表。
- 不改插件观测台的其它功能。
