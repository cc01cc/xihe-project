# 配置 Effective Source 与进程可见性

> 契约状态：`proposed`  
> 实现状态：`partial`  
> Owner：CP ConfigService + process-specific consumers  
> 消费者：CP、Agent、Runtime、UI、Audit  
> 来源：PLAN-0389、DEV-003、ConfigService、config-management、PLAN-0574
> 更新日期：2026-10-29

## 层与优先级

目标 effective chain：`per-call > CLI --set > env > workspace > user > instance > code default`。`env` 命中后锁定对应 key；workspace/user/instance 仍可展示原值和被覆盖原因，不静默合并。**业务链 `CLI --set` 为 deferred（PLAN-0574 裁定）**：该层当前没有消费方语义（业务域键以 DB 为权威，env 兜底已单独登记），先在 spec 定义语义再实现，CLI 不提供业务域 `--set` 入口。

## bootstrap `--set`（已实现，PLAN-0574 M4）

bootstrap 基础设施键的 `CLI --set` 与上述业务链是**两个不同的面**：实际机制为 launcher（`scripts/stack-run.mjs`）在白名单校验后把值直接写入被启动子进程的环境变量，优先级 `CLI --set > 进程已有 env（OS env / mise / 派生默认） > .env 文件链 > 代码默认`。首批白名单仅 `XIHE_CP_PORT` / `XIHE_AGENT_PORT` / `XIHE_RUNTIME_PORT`（十进制 1..65535），只注入实际消费该键的目标；未知键、敏感键与不合法值在 launcher 侧拒绝，错误不回显输入值；显式 URL（`XIHE_CP_URL` / `XIHE_AGENT_URL(_BASE_URL)` / `XIHE_RUNTIME_URL`）已设置时端口覆盖只改监听端，launcher 打印断链风险提示。三模块内置 loader 不解析 CLI argv，其 `--set` 解析器保留但当前无 argv 通道。映射与消费点详见 `../config-env-target.md` §1.2 与 DEV-003 §2。

Credentials 不等于普通 config KV：API key/token 由 provider connection/lease/secret boundary 管理，UI/Agent 只收到必要的 opaque lease/metadata，audit 不记录原文。

## 进程可见性

| 进程 | 能读取 | 不能假设能读取 | 输出要求 |
|---|---|---|---|
| CP | DB instance/user/workspace、EnvOverlayRegistry、code defaults、per-call/CLI input | Runtime host env/CLI 的实时值 | effective value/source/revision/lock/conflict；audit change |
| Agent | CP 下发的 effective config/run payload、必要 lease；按 run 身份 `(workspaceId, userId)` 拉取的 run 级 effective 快照（PLAN-0590，5 域：llm-provider/agent-profile/rag/agent-runtime/context-policy） | CP DB、Runtime host env、其他 Workspace config；不得把 env `XIHE_WORKSPACE_ID` 绑定快照当 run 基线 | metadata 标 source/revision；不自行 resolve precedence；run 快照解析日志含 `workspaceId`/`userId` 摘要 |
| Runtime | 自身 bootstrap env/CLI（PORT/HOST/DB/JWT/backend/storage 等）和 CP execution spec | CP user/workspace DB layer，除非 CP 显式下发 | environment snapshot/provenance；host secrets 不回传 |
| UI | CP 生效结果/层级/env lock 响应、capability available/reason | 进程 env、DB raw secret、Runtime host absolute path | 展示最终 source、被覆盖 key、lock reason 和 capability reason |

Runtime env 不是 CP/Agent 可直接读取的 source；Agent env block 由 Runtime 基于最终实际执行环境生成，再经 CP 打包传播。

## 透明性与失败

- 同 key 多来源冲突必须在 UI、Agent/service metadata、日志/audit 三通道可见。
- per-call input 只影响本次操作，不能静默写入持久层。
- schema invalid、secret unavailable、env unsafe/default fail-fast、unknown Workspace 显式失败；不得回退到旧 system/admin 或默认 provider。
- source/revision 过期、配置变更和 Workspace generation mismatch 必须触发 refresh/reject，不使用陈旧 effective value。
  - **Supersede（PLAN-0590，2026-10-31 Lead 裁定 #2）**：Agent 侧的 **run 级配置快照**允许**有界 stale**——仅当存在同一 `(workspaceId, userId)` 的旧快照、且其 age ≤ 2×TTL（TTL 默认 60 s，env `XIHE_AGENT_CONFIG_SNAPSHOT_TTL_S`）时继续服务，并 MUST 产出 `config_snapshot_stale` WARN 与 `config_snapshot_stale_total` 指标；超出该窗口、或不存在任何快照时 MUST fail-closed（`AGENT_CONFIG_SNAPSHOT_UNAVAILABLE`），**不得**回退到进程 workspace 绑定的 effective 快照。该例外只适用于 Agent 进程内的 run 快照，不改变 CP 侧 `effective` 计算的新鲜度要求，也不做按域分级（否决「按域不同失效语义」）。

## 验证映射

- 当前 CP chain：DEV-003、`ConfigService.effective()`、EnvOverlayRegistry。
- Runtime/Agent visibility：DEV-003、Runtime AGENTS、Agent run payload contract。
- transparent source、credential redaction、env unsafe defaults：PLAN-0389 T3.1/T3.3/V7，尚未完成。
