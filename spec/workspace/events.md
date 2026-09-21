# Workspace 文件事件

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Owner：Runtime watcher（hint）+ CP sequence/SSE projection  
> 消费者：UI Workspace store、CP refresh、Runtime file tools  
> 来源：PLAN-0389、PLAN-0350、DEV-015  
> 更新日期：2026-09-21

## 事件语义

Runtime watcher 只发送 Workspace-relative POSIX path、`created/modified/deleted` hint；CP 分配 sequence、做 Workspace authorization 并向 UI 发送 Workspace SSE。文件正文/目录树通过 HTTP/MCP 查询，事件不是正文 source。

事件队列有界且非阻塞；overflow、watcher error、canonicalization failure 转 `snapshot_required` 或显式 watcher failure。不得发送 host absolute path、secret、完整文件内容或 checkpoint ref。

## 订阅与 owner

- 事件以 `workspaceId` 为权限与订阅主键，不依赖 Session；Workspace 可在无 Session 时继续发事件。
- UI Workspace SSE 与 Chat SSE 分离；断线后通过 snapshot/HTTP refresh 补偿，不假设 exactly-once replay。
- CP sequence 是事件顺序权威；Runtime 不生成可持久化全局序号。

## 负向约束

- 文件事件不得生成 checkpoint capture、import job 或 Session。
- checkpoint capture/restore 不生成 file event replay；restore 后以显式 snapshot/refresh 重新读取。
- sequence gap 只能触发 `snapshot_required`，不能伪造中间事件。
- watcher stop 随 Workspace destroy/eviction 清理；失败路径不得遗留进程、队列或端口。

## 验证映射

- 当前实现：Runtime `workspace_events.rs`、PLAN-0350。
- CP route/SSE/OpenAPI：CP Workspace Event controller/inventory。
- queue overflow、断线、snapshot refresh：PLAN-0389 T3.3/V7，尚未完成。
