# Sandbox backend 与 capability

> 契约状态：`proposed`  
> 实现状态：`partial`（Docker seam 已有；Windows `windows-mxc`/`windows-host` 一次性执行与 Job 归属、MXC policy 字段集、能力透出已落地——PLAN-0379/0393/0394/0395/0397；release/resume 与 Docker Job adapter（0392）未完成）  
> Owner：Runtime SandboxBackend  
> 消费者：CP preflight、Workspace UI、Agent tool path、Runtime executor  
> 来源：PLAN-0389、DEV-031、PLAN-0329/0347/0379  
> 更新日期：2026-09-21（状态同步：Windows backend 已落地）

## 公共能力快照

```json
{
  "contractVersion": "v1",
  "backendKind": "docker|windows-mxc|windows-host",
  "maturity": "stable|experimental",
  "executionMode": "docker|windows-mxc|windows-host",
  "available": true,
  "reason": null
}
```

`backendKind` 是稳定身份；`maturity` 表示成熟度。`profile` 只属于需要它的 backend（Docker 的 strict/coding/isolated），不跨 backend 解释安全语义。platform/provider/backendRevision 是 diagnostics，不是第二个可用性来源。

## 必备与可选能力

- 必备接缝：`ensure`、`destroy`、`execute`、`capabilities`。
- 可选能力：`session`、`fs_transfer`、`network_policy`、`checkpoint`、`pause_resume`、`watch`、`pty`，缺失时返回 `UNSUPPORTED`。
- `declared/probed/reason` 可在 Runtime 内部保留；CP/UI/Agent 只消费最终 `available/reason`。
- `declared=true` 与 `probed=false` 冲突必须 fail-closed；不得静默 fallback 到 Docker、host 或 read-only。

## Docker、MXC 与显式宿主

- Docker 是当前 Runtime backend 实现；Docker transport、container IP/port/pid、network_mode 不出现在 seam 之上。
- `windows-mxc` 是受限、experimental backend；能力不可用时显示 reason，由用户显式选择 `windows-host` 作为可用性兜底。
- `windows-host/unrestricted` 是用户明确选择的不受限宿主执行，不是 sandbox fallback，不提供 Workspace 外写保护；必须有权限、确认、审计、超时和取消。
- 0389 不实现 MXC、Docker guard 或 host runner；PLAN-0379 是 backend implementation owner，0384 是 UI/mode confirmation owner。

## 长驻 session

MCP 长驻 session 是可选能力；后端没有 session 但有 execute 时只能按 per-call 语义，二者都没有则 `UNSUPPORTED`。不能因为某后端当前支持 Docker exec 就声称所有 backend 都支持 session。

## Windows 进程收容与进程树语义（PLAN-0379 草案已合并，2026-09-21）

`windows-mxc` 不自己实现隔离：隔离**委托**给 MXC 与 Windows 内核；XH 引擎负责策略映射、探测、超时/取消，并以**自己持有的 Job Object** 承担进程树回收与零残留确认。

| 关注点 | 结论 |
|---|---|
| 隔离承载 | MXC + Windows OS（`processcontainer` 运行期选档：T1 BaseContainer/PSEC、T3 AppContainer + DACL）；档位与令牌 **MUST NOT** 上浮为公共契约字段 |
| 回收承载 | XH 引擎 Job Object（挂起态入组 + `KILL_ON_JOB_CLOSE`）与 MXC 策略 Job 可嵌套共存：**策略归 MXC，回收归引擎** |
| 进程可见性 | Windows 收容**没有 PID namespace**，PID 是宿主全局 PID；Job 提供回收语义，不提供视图隔离 |

不变式：

| # | 不变式 | 关键字 |
|---|---|---|
| W1 | 受限 backend 只有在 probe 报告可用时才可执行；探测失败、策略不可表达、未知 Workspace 一律 fail-closed | `MUST` |
| W2 | 超时、取消、父进程退出三条终止路径都必须清空整棵进程树，并在返回前确认零残留；无法确认必须显式上报，不得以退出码掩盖 | `MUST` |
| W3 | 隔离由 MXC/OS 执行；XH **MUST NOT** 用路径语法限制替代隔离，也 **MUST NOT** 因 probe 失败自动回退 Docker / `windows-host` / 只读降级 | `MUST NOT` |
| W4 | `windows-mxc` 必须报告 `maturity: experimental`；`windows-host` 必须把 workspace 外写范围报告为不支持 | `MUST` |
| W5 | 任何依赖「收容内进程对宿主不可见」的设计假设 **MUST NOT** 进入契约 | `MUST NOT` |
| W6 | v1 `windows-mxc` 必须报告长驻会话不支持；长驻 MCP、PTY、浏览器会话 **MUST NOT** 用一次性执行伪装 | `MUST NOT` |

超时分层（**MUST NOT** 相互替代）：进程时限（MXC policy `process.timeout`）≠ 请求时限（调用方等待）≠ Job 运行时限（引擎预算，暂停不计时）。「超时返回 ⇒ 树已清空」仅在 `processcontainer` 这类有树原语的后端成立；会话型后端 v1 不引入。

失败语义：`UNSUPPORTED`/`SANDBOX_PROBE_FAILED`（探测失败）、`POLICY_INVALID`（策略不可表达）、`PATH_OUT_OF_SCOPE`（后端边界拒绝，非输入语法校验）、`PROCESS_TIMEOUT`/`PROCESS_CANCELLED`（整树终止并确认不残留）、`PROCESS_TREE_CLEANUP_FAILED`（清理无法确认必须显式上报）。

Job 生命周期、输出留存与重启对账见 `spec/workspace/execution-job.md`（未确认 Job 标记 `interrupted`，**MUST NOT** 自动重放）。机制细节与真实证据见 PLAN-0379 `evidence/` 与 `plans/archive/PLAN-0393…0397/evidence/`。

## 验证映射

- 当前 Runtime seam：`packages/runtime/src/backend.rs`、DEV-031。
- Windows backend target/evidence：PLAN-0379（一次性执行）+ PLAN-0393/0394/0395/0397（Job 引擎、MXC/Host adapter、one-shot 收敛）；证据见各计划 `evidence/`，当前 partial 仅剩 release/resume 与 Docker Job adapter（0392）。
- fail-closed、capability mismatch 和 explicit host：PLAN-0389 T3.2/V7，尚未完成真实 backend 证据。
