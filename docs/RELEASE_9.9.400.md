# dao-proxy-pro 9.9.400 发布说明

## 修复内容

- 修复 Devin 已打开项目、ACP 已注册根目录，但 `grep_search/find_by_name` 仍提示路径不在活动工作区的问题。
- `Scripts`、`/Scripts`、`\Scripts` 会在调用 Devin 原生搜索器前解析为当前项目中的真实绝对目录；Unity 项目可稳定解析为 `Assets\Scripts`。
- Reload Window 期间 `workspaceFolders` 短暂为空时，保留最近一次有效工作区根，不再把路由器环境清空。
- 修复中文“项目根目录 / 项目路径 / 工作区根目录 / 当前工作目录”标签识别规则。
- 多根 `.code-workspace` 保持消歧保护：若多个项目包含同名目录，插件不擅自选择第一个项目。
- 异常路径只记录一次本地诊断，不启用代理搜索器，不增加模型调用、工具重试或上下文内容。
- 路由模型仍按配置执行高强度推理，但默认不再向 Devin 输出可见思考过程；内部工具续跑与空闲保活改用元数据帧，不再显示“Thought for …”。如需恢复旧显示，可设置 `DAO_EXPOSE_REASONING=1`。

## 验证

- 真实项目根 `E:\新增运行时状态机`：
  - `Scripts` -> `E:\新增运行时状态机\Assets\Scripts`
  - `/Scripts` -> `E:\新增运行时状态机\Assets\Scripts`
  - `Assets` -> `E:\新增运行时状态机\Assets`
- 单次路径归一化约 1.6-2.8ms。
- 核心全链路自检 `347/347` 通过。
- 工作区策略 `32+15` 项通过。
- 本地路径、ACP session/new 与 ACP stdio 代理回归全部通过。

## 行为边界

插件继续把搜索调用交给 Devin 原生工具执行，仅修正明显错误的相对路径。绝对路径逐字保留；多根工作区无法唯一判定时不猜测，并在 `_router_diag.log` 记录原因供排查。
