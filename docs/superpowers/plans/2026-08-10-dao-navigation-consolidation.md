# Dao Flow 导航收口实现计划

## Task 1：分组模型

- [x] 先写 views 测试：四组顺序、成员不丢失、所有 view ID 唯一可达。
- [x] 增加 advanced group，移动低频连接视图并更新直白文案。
- [x] 运行 focused tests、typecheck、lint、diff check。

## Task 2：可折叠高级连接

- [x] 先写 Sidebar/App 测试：默认折叠、活动高级视图展开、用户手动展开。
- [x] 实现 renderer-only 折叠状态，保持 command palette 与持久化 view 行为。
- [x] 运行 focused 与全量桌面回归。

## Task 3：收尾

- [x] 更新 README/parity 导航说明。
- [x] 运行 build、Electron bundle、root smoke。
- [ ] Taskboard 服务恢复后同步 DAOFLOW-5 状态。
