# Sandbox backend 与 capability

> 契约状态：`proposed`  
> 实现状态：`partial`（Docker seam 已有；Windows backend 未完成）  
> Owner：Runtime SandboxBackend  
> 消费者：CP preflight、Workspace UI、Agent tool path、Runtime executor  
> 来源：PLAN-0389、DEV-031、PLAN-0329/0347/0379  
> 更新日期：2026-09-21

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

## 验证映射

- 当前 Runtime seam：`packages/runtime/src/backend.rs`、DEV-031。
- Windows backend target/evidence：PLAN-0379；当前仍 partial。
- fail-closed、capability mismatch 和 explicit host：PLAN-0389 T3.2/V7，尚未完成真实 backend 证据。
