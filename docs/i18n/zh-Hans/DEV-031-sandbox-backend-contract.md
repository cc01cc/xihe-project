---
title: DEV-031 - 沙盒后端契约
category: dev-guide
sidebar_order: 31
lang: zh-Hans
sidebar_group: "开发指南"
status: active
created: 2026-09-15
---

# DEV-031: 沙盒后端契约

> 面向 Runtime 开发者与换后端评估者：定义 `SandboxBackend` 的必备接口（动词 + 能力查询）、能力声明与跨后端语义约束（§1–5）、长驻 stdio MCP 的三档映射（§6），以及 Docker 后端的现状对照（§7）。设计原则见 `sandbox-backend-abstraction` skill；泄漏审计记录见 PLAN-0329。

## 1. 定位与边界

- 契约描述「上层如何请求执行环境」；**Docker / 端口发布 / 容器内 HTTP 一律不进入本层**。
- 现状边界：`execute` 接缝（seam：可以替换实现而不改动调用方的接口边界）已收敛在 `WorkspaceExecutionRouter`（per-request exec，即「每次操作单独执行」）；`ensure/destroy` 接缝当前位于 `WorkspaceManager`/`WorkspaceRegistry` 双路径，收敛由工作区生命周期专项承接——**本契约描述目标态**。
- 六条不变式（invariant，指任何后端实现都必须始终满足的约束）：
  1. 必备接口在所有后端都有非空实现；
  2. 缺能力时显式返回 `UNSUPPORTED`（不支持），不做静默降级（详见 §3）；
  3. 接缝上不出现 Docker 概念；
  4. 能力声明必须同时包含「声明支持」与「实测结果」，两者不一致时按拒绝处理（详见 §3）；
  5. 连接可断开，客户端必须能重连（详见 §5）；
  6. 销毁执行实体不得删除工作区数据（详见 §5）。

## 2. 必备接口

| 接口 | 语义 | 边界 |
|---|---|---|
| `ensure(spec) -> handle` | 确保执行环境存在并返回句柄（provision：创建或激活执行环境；幂等：重复调用结果一致） | 可重建；**重建/销毁不得删除 WorkspaceStorage**；spec 不满足时按拒绝处理（fail-closed），不得以本地默认替换 |
| `destroy(handle)` | 销毁执行实体（容器/VM/进程树） | 可重复调用；失败可区分（`cleanup_failed`），不得以退出 0 掩盖残留 |
| `execute(op) -> result` | 操作粒度执行：argv/cwd/env 显式；流式输出；可取消；带超时与 exit code | 有界、可取消；不提供隐式 shell 状态 |
| `capabilities() -> map` | 能力查询：返回各能力的声明与实测结果（定义见 §3） | 必备；所有后端都要实现；调用未声明能力返回 `UNSUPPORTED` |

判定标准：**某接口若某后端只能抛「不支持」，它就不能进必备集**，应降为该后端的能力声明。

## 3. 能力声明与 `UNSUPPORTED`

```
capabilities() -> { <capability>: { declared, probed, reason } }
```

- `declared`（声明支持）、`probed`（启动或调用前的实测结果）与 `reason`（不支持或降级的原因）三者齐备；`declared` 与 `probed` **不一致即 fail-closed**。
- 探测失败或未实现 → 显式降级或拒绝；禁止静默降级（实证：Claude 默认 fail-open，即失败时放行而不拦截；Landlock `BestEffort` 静默过滤；Codex Windows 未启用沙盒时 `workspace-write` 静默降级 read-only）。
- 调用未声明能力 → 返回 `UNSUPPORTED` 并附 `reason`；调用方**按能力分支，不按后端名分支**。

## 4. 可选能力

| 能力 | 语义要点 |
|---|---|
| `session` | 长驻会话（可多次执行、保持进程状态）：双向流 + 进程生命周期 + `reconnect`（快照/恢复/重建后连接必失效，客户端须重连） |
| `fs_transfer` | 上传/下载；**有 workspace 挂载时优先挂载**，transfer 作兜底 |
| `network(policy)` | 粒度档位声明：`none` / 开关 / 域名或 IP 列表 / 端口级 |
| `snapshot_revert` | 维度分离：**fs / memory / boot-template**；`in-place revert`（原地回滚）与 `clone-from-snapshot`（从快照另起新环境）是两种语义 |
| `pause_resume` | 明确「保留什么」：仅 fs（进程死）或 fs+memory（进程续） |
| `endpoint(port) -> URL` | 端口 → 可达 URL；须声明**可达范围**（本机 / 宿主 / 公网） |
| `pty` | 交互终端（语义同 execute，附加 TTY，即终端设备） |
| `watch` | 文件/目录变更事件 |

**命名预留（不定义语义、不绑定实现）**：`host_tools`、`display`、`gpu`、`identity`、`fs_view`、`checkpoint`。预留仅避免未来改名破坏兼容；不得据此预建机制。

## 5. 跨后端语义约束

> 本节列出从 Docker 换到其他后端（microVM / 远程执行）时上层必须知道的五条语义约束；术语在首次出现处解释。

1. **工作区数据与执行实体分离**：工作区数据（代码、文件）存放在工作区存储（`hostRoot/<workspaceId>`）；沙盒只是可替换的执行实体。容器被删除或重建不影响工作区数据——`destroy` 只销毁执行实体，不得删除工作区目录。
2. **连接会失效，必须支持重连**：快照、暂停恢复、实体重建都会使既有连接失效，且由后端机制决定，不是故障：E2B 快照会中断所有 WebSocket/PTY/命令流；Firecracker 恢复快照后重置 vsock（虚拟 socket）；gVisor 恢复后对端收到 `ECONNRESET`（连接被重置的错误码）。因此长连接（MCP 通道、事件流）必须实现断线重连与会话恢复；`session` 能力把 `reconnect` 作为定义的一部分，不假设连接持久。
3. **快照按维度声明**：快照（snapshot）必须说明恢复范围，不能假设为全量：
   - fs 快照（文件系统）：文件保留、进程丢失（相当于重启）；
   - 内存快照：进程继续运行，但连接仍会失效（按第 2 条重连）；
   - 模板快照（boot template）：只定义启动起点，不含运行时状态。
   各后端支持维度不同（如 Runloop 仅磁盘、E2B 含内存），调用方按声明维度预期。
4. **网络策略按表达力声明**：「能联网」不是布尔值，粒度因后端而异：
   - 网络命名空间（network namespace，Linux 的网络隔离单元）：仅通/断；
   - HTTP 代理：可做域名级白名单（XH 当前的 audit-proxy 属此档）；
   - microVM：出网经隧道（宿主侧转发通道），粒度单独定义。
   契约声明表达力档位，调用方按需选择。
5. **工作区文件接入方式**：文件如何进入沙盒由后端决定；契约只承诺「沙盒内可见工作区数据，且数据不因沙盒生命周期而丢失」，三种形态的语义需按声明预期：
   - 挂载（mount，如 bind mount、virtiofs）：宿主与沙盒共享同一份文件，修改立即可见（XH 现状）；
   - 同步（sync）：向沙盒推送副本并把改动同步回工作区存储，存在延迟与冲突处理问题；
   - 复制（copy）：进出各一次，最简单、最慢。
   沙盒内文件与工作区存储不一致时，一律以工作区存储为准。

## 6. 长驻 stdio MCP 三档映射

> stdio（标准输入输出管道）是 MCP 连接本地进程的默认传输方式；这类 MCP server 进程运行在**工作区容器内**（需要容器内的文件与环境），宿主侧需要通过一个通道与它通信。本节「三档」指契约对这类长驻进程的支持等级。

| 档 | 条件 | 行为 |
|---|---|---|
| 1. session | 后端声明 `session` | 宿主作为客户端，经 session 的双向流收发消息；进程生命周期由 session 承载 |
| 2. per-call execute | 仅有 `execute` | 每次调用启动一个新进程（MCP 本身无会话状态；代价是冷启动、无进程内状态） |
| 3. 不支持 | 两者皆无 | 返回 `UNSUPPORTED`（fail-closed，不静默改走其他方式） |

现状：当前 MCP bridge 依赖「沙盒内 HTTP 服务 + 端口发布 + 容器 IP 解析」，只能在 Docker 后端工作，不构成通用的 session 能力，列为「待迁移」；native Windows 上动态端口不可达（已实测），该方式不可用。

## 7. 现状映射（Docker 后端）

| 契约项 | 现状实现 | 备注 |
|---|---|---|
| `execute` | per-request exec（`xihe-container-runtime --oneshot`） | 已在接缝上 |
| `ensure` / `destroy` | 容器生命周期 + 物化重建；`WorkspaceManager`/`Registry` 双路径 | 双路径收敛归工作区生命周期专项 |
| `session` | bridge（HTTP + 端口发布） | 泄漏清单「待迁移」 |
| `endpoint(port)` | 39001 发布 + 宿主随机端口 | 「vestigial（残留、已无消费者）」 |
| `network(policy)` | `network_mode` none/bridge + 代理 env | 接缝下实现 |
| 快照/回滚 | 不在沙盒层（属工作区文件变更层，归 PLAN-0328 范围） | 与执行实体解耦 |

## 8. 变更规则

- 契约向「能力扩展」演进，不回退为后端名分支；冻结后修改须在对应 PLAN 记录 supersede。
- 新增后端只实现契约 + `capabilities()`；消费方按能力分支，缺失能力显式 `UNSUPPORTED`。
