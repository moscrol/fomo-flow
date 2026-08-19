# Dao Flow Work Item 产物审阅实现计划

## Task 1：安全产物模型与测试

- [x] 写失败测试：终态/错误/空产物、数量上限、脱敏与 ID 不泄漏。
- [x] 实现纯 renderer-owned 投影模块，复用既有归一化任务数据。
- [x] 运行 focused tests、typecheck、lint、diff check。

## Task 2：接入当前工作桌

- [x] 在任务 Work Item 详情中加入直白审阅卡片与交接入口。
- [x] 保持 GET-only、无自动执行、无 priority 写入。
- [x] 运行 focused 与全量桌面回归。

## Task 3：收尾

- [x] 更新 parity/README 边界说明。
- [x] 运行 build、Electron bundle、root smoke。
- [ ] Taskboard 服务恢复后同步 DAOFLOW-4 状态。
