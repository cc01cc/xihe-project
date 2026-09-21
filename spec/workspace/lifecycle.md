# Workspace 生命周期与绑定

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Owner：CP Workspace + Runtime lifecycle  
> 消费者：Session、UI、Agent、Runtime、Security  
> 来源：PLAN-0389、PLAN-0345、DEV-015、DEV-017  
> 更新日期：2026-09-21

## 分层

| 层 | 语义 | owner |
|---|---|---|
| Workspace logical resource | 名称、描述、owner、storage binding、execution binding、generation、deletedAt | CP durable Workspace |
| Session binding | Session 对一个 Workspace 的可选绑定 | CP Session |
| Execution entity | Sandbox/host process 的物化实体 | Runtime lifecycle/backend |
| WorkspaceStorage | 工作区文件的逻辑/宿主存储根 | CP binding + Runtime canonical path |
| Config projection | instance/user/workspace/env 的 effective 结果 | CP ConfigService；Runtime/Agent 只消费各自输入 |

Workspace 可以没有 Session；Session 依赖 Workspace 绑定，但 Workspace 不依赖 Session。

## Session 不变式

1. 一个 Session 最多绑定一个 Workspace。
2. Session 生命周期内不允许 rebind 到另一个 Workspace。
3. Workspace 切换通过选择/创建新 Session；不把切换写成旧 Session mutation。
4. 旧 Session 的 MCP、文件引用、授权、lease、bridge、job 和 ChatRun 状态不迁移到新 Workspace。
5. 新 Workspace 可以先创建、导入、配置和物化，再创建 Session。

## Runtime canonical state

Runtime canonical state 为 `creating → ready → paused/stopped/failed → destroying`，六态具体 transition 由 `Lifecycle` owner；`destroying` 完成后执行实体注销，不产生常驻 destroyed state。

CP/UI 可有 projection state：`materializing` 对应 Runtime `creating`，`blocked` 对应 Runtime `failed`/capability unavailable，`ready`/`paused`/`stopped` 直接映射。Projection 不得写回或改名 Runtime canonical state。

## Binding 与路径安全

- CP 保存 logical `storageRef`/binding，不把未经授权的任意 raw path 当成 Runtime storage authority。
- Runtime 对 canonical path 做 allowlist、ownership、case-normalized prefix、symlink/junction/reparse 和 TOCTOU 校验。
- `hostPath`、canonicalPath、storageRef、用户可见 displayPath 是不同字段；Environment 按 owner/admin/member 权限返回不同投影，普通 member 不默认得到原始宿主路径。
- 执行实体销毁/重建不得删除 WorkspaceStorage；unknown Workspace、路径越界和 capability 不可用均 fail-closed。

## 验证映射

- 当前事实：PLAN-0389 `evidence/current-state.md`、`owner-matrix.md`。
- Session 边界：`spec/session/chat-session.md`、PLAN-0387。
- 真实 lifecycle/recovery：PLAN-0389 T3/V7，尚未完成。
