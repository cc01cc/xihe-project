# Workspace Storage 与 Checkpoint slice

> 契约状态：`proposed`  
> 实现状态：`partial`（shadow Git slice 已有）  
> Owner：Runtime storage/checkpoint + CP logical projection  
> 消费者：CP workspace API、UI、Runtime、Operation audit  
> 来源：PLAN-0389、DEV-015、PLAN-0338/0339/0358、windows-storage-safety  
> 更新日期：2026-09-21

## Storage binding

- Logical Workspace identity 是 `workspaceId`；`storageRef` 是经过 CP/Runtime binding 校验的逻辑引用。
- Runtime canonicalizes hostRoot + storageRef，做 case-insensitive prefix、reparse/symlink、ownership 和 TOCTOU 校验；`../`、绝对路径、junction escape、cross-workspace storageRef 必须拒绝。
- 物理 canonical path 不作为任意 public response；UI 使用 display path/availability projection。
- execution entity destroy/rebuild、pause/stop/evict 不删除 WorkspaceStorage。

## Checkpoint slice

- shadow repo：`<hostRoot>/.xihe-shadow/<workspaceId>.git`，不 bind 到 Sandbox，也不读写用户仓库 `.git`。
- ref：`refs/xihe/slices/<capturedAtEpochMs>-<commitHash>`；独立 root commit，无 parent 分支语义。
- capture：短 capture lock → isolated Git index → write-tree → noChange 或新 slice；restore：preview diff → explicit execute → delete then restore → suspects 复核。
- default nested repo 为 opaque gitlink；超过大小/凭据/Runtime 文件排除规则的内容显式 skipped，不静默进入 slice。
- retention 有 slice count/TTL 上限；cleanup busy、Git unavailable、unknown Workspace、type conflict 显式失败。

## Migration/round-trip boundary

本计划 `dataMigration=yes`：checkpoint、import/copy 和 storage binding 都必须有字段/幂等/失败清理/备份恢复/round-trip 证据。旧 container snapshot/revert 语义 supersede，不与 slice 混用。

负向断言：checkpoint 不生成 Workspace file event；Workspace file event 不触发 checkpoint/replay；checkpoint 不写用户 `.git`；storage entity 删除不删除 WorkspaceStorage。

## 验证映射

- Runtime implementation：`checkpoint.rs`、`storage.rs`、DEV-015。
- round-trip：PLAN-0389 T3.1/V7，当前未完成真实证据。
