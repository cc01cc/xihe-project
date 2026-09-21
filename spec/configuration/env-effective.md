# 配置 Effective Source 与进程可见性

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Owner：CP ConfigService + process-specific consumers  
> 消费者：CP、Agent、Runtime、UI、Audit  
> 来源：PLAN-0389、DEV-003、ConfigService、config-management  
> 更新日期：2026-09-21

## 层与优先级

目标 effective chain：`per-call > CLI --set > env > workspace > user > instance > code default`。`env` 命中后锁定对应 key；workspace/user/instance 仍可展示原值和被覆盖原因，不静默合并。

Credentials 不等于普通 config KV：API key/token 由 provider connection/lease/secret boundary 管理，UI/Agent 只收到必要的 opaque lease/metadata，audit 不记录原文。

## 进程可见性

| 进程 | 能读取 | 不能假设能读取 | 输出要求 |
|---|---|---|---|
| CP | DB instance/user/workspace、EnvOverlayRegistry、code defaults、per-call/CLI input | Runtime host env/CLI 的实时值 | effective value/source/revision/lock/conflict；audit change |
| Agent | CP 下发的 effective config/run payload、必要 lease | CP DB、Runtime host env、其他 Workspace config | metadata 标 source/revision；不自行 resolve precedence |
| Runtime | 自身 bootstrap env/CLI（PORT/HOST/DB/JWT/backend/storage 等）和 CP execution spec | CP user/workspace DB layer，除非 CP 显式下发 | environment snapshot/provenance；host secrets 不回传 |
| UI | CP effective/layer/env lock projection、capability available/reason | 进程 env、DB raw secret、Runtime host absolute path | 展示最终 source、被覆盖 key、lock reason 和 capability reason |

Runtime env 不是 CP/Agent 可直接读取的 source；Agent env block 由 Runtime 基于最终实际执行环境生成，再经 CP 打包传播。

## 透明性与失败

- 同 key 多来源冲突必须在 UI、Agent/service metadata、日志/audit 三通道可见。
- per-call input 只影响本次操作，不能静默写入持久层。
- schema invalid、secret unavailable、env unsafe/default fail-fast、unknown Workspace 显式失败；不得回退到旧 system/admin 或默认 provider。
- source/revision 过期、配置变更和 Workspace generation mismatch 必须触发 refresh/reject，不使用陈旧 effective value。

## 验证映射

- 当前 CP chain：DEV-003、`ConfigService.effective()`、EnvOverlayRegistry。
- Runtime/Agent visibility：DEV-003、Runtime AGENTS、Agent run payload contract。
- transparent source、credential redaction、env unsafe defaults：PLAN-0389 T3.1/T3.3/V7，尚未完成。
