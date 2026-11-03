# Workspace Storage 与 Checkpoint slice

> 契约状态：`proposed`  
> 实现状态：`partial`（shadow Git slice 已有）  
> Owner：Runtime storage/checkpoint + CP checkpoint 切片记录  
> 消费者：CP workspace API、UI、Runtime、Operation audit  
> 来源：PLAN-0389、DEV-015、PLAN-0338/0339/0358、windows-storage-safety  
> 更新日期：2026-09-21

## Storage binding

- Logical Workspace identity 是 `workspaceId`；`storageRef` 是经过 CP/Runtime binding 校验的逻辑引用。
- `XIHE_WORKSPACE_HOST_ROOT` 是进程级 host root（managed 父目录 + shadow 状态根），不是每个 workspace 一个根；源值可相对，注入 Runtime 的进程值必须绝对；`hostRoot/storageRef` 为 managed 内容路径，direct_attach 内容路径来自 `hostPath`。
- Runtime canonicalizes hostRoot + storageRef，做 case-insensitive prefix、reparse/symlink、ownership 和 TOCTOU 校验；`../`、绝对路径、junction escape、cross-workspace storageRef 必须拒绝。
- 物理 canonical path 不作为任意 public response；UI 使用 display path/可用性摘要（按权限裁剪）。
- execution entity destroy/rebuild、pause/stop/evict 不删除 WorkspaceStorage。

## Workspace roots（PLAN-0639 M1 承接）

- 一个 Workspace 可声明 **N 个根**（`workspace_roots` 表，D39-2/D39-3）。根[0] 是主根，`id = workspace.id`（主根不变式）。根的运行期 CRUD：新增根即刻可用（文件访问/授权/watcher），影子库惰性创建；删除根 = 软删 + 影子库原地归档，旧切片冻结可读、execute-revert 409 `ROOT_DELETED`；重加同路径 = 新 rootId 不复用旧史。
- 根间是**硬边界**：路径解析「先定根、再解析」，canonical 后须落在声明根内；跨根 symlink 拒绝（`SymlinkEscape` 同码同义）。嵌套根（完整包含）允许，事件只归最深声明根；部分重叠 400 `INVALID_ROOT_OVERLAP`。
- `run_checkpoints.root_id` 是逻辑引用（V76 原样，不加 FK），CP 服务层保证引用完整。

## Checkpoint slice

- shadow repo：`<hostRoot>/.xihe-shadow/<rootId>.git`（PLAN-0639 起 rootId 取代 workspaceId；存量单根 rootId=workspaceId 路径逐字节不变）。每根一影子库（D-1），不 bind 到 Sandbox，也不读写用户仓库 `.git`。
- ref：`refs/xihe/slices/<capturedAtEpochMs>-<commitHash>`；独立 root commit，无 parent 分支语义。
- capture：短 capture lock → isolated Git index → write-tree → noChange 或新 slice；restore：preview diff → explicit execute → delete then restore → suspects 复核。
- nested repo 默认 **L1 文件级展开**（PLAN-0361）：跳过子仓 `.git`，子仓文件作普通 blob 进父切片、可按文件恢复；`opaqueNestedRepos[]` 在 L1 下为空。策略 `flatten`（默认）/`opaque`（旧 gitlink）/`reject`。超过大小/凭据/Runtime 文件排除规则的内容显式 skipped，不静默进入 slice。
- capture reason 词表：`GIT_UNAVAILABLE/GIT_TOO_OLD/GIT_FAILED/WORKSPACE_UNKNOWN/NESTED_REPO_LIMIT`；CP 仅在 `UNAVAILABLE` outcome 透传为 durable reason，未知/transport 归一 `UNAVAILABLE`；`EXPIRED/TOO_LARGE/MISSING/DEGRADED` 为 gate-only。
- retention 有 slice count/TTL 上限；cleanup busy、Git unavailable、unknown Workspace、type conflict 显式失败。

## Migration/round-trip boundary

本计划 `dataMigration=yes`：checkpoint、import/copy 和 storage binding 都必须有字段/幂等/失败清理/备份恢复/round-trip 证据。旧 container snapshot/revert 语义 supersede，不与 slice 混用。

负向断言：checkpoint 不生成 Workspace file event；Workspace file event 不触发 checkpoint/replay；checkpoint 不写用户 `.git`；storage entity 删除不删除 WorkspaceStorage。

## 验证映射

- Runtime implementation：`checkpoint.rs`、`storage.rs`、DEV-015。
- round-trip：PLAN-0389 T3.1/V7，当前未完成真实证据。
