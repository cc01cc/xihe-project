# XH 安全审计

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：CP/Security；来源：PLAN-0386、logging-observability-security；更新：2026-09-20。

## 1. 审计记录

Audit 记录 action、principal 摘要、resource/workspace、operation/request 关联键、policy/approval 结果、source layer/origin、时间和安全 reason。诊断日志可以单独保留 stack trace；audit 不包含 raw request body。

## 2. 当前边界

CP `AuditLogger` 写入专用 AUDIT JSONL logger，并保留有界的 recent-memory view。当前尚未实现 DB/ELK durability；该差距必须显式保留，不能暗示已经持久化。

## 3. 规则

- Logs 和 audit **MUST NOT** 包含 token、secret、Cookie、完整 Authorization、raw tool arguments 或 provider credentials。
- 关联使用 requestId/runId/sessionId/workspaceId/operationId 和安全 hash/summary。
- 脱敏发生在 serialization boundary，不能只依赖调用点自觉处理。
- Authentication failure、authorization denial、capability rejection、approval decision、credential refresh/scope mismatch 和 operation 终态 **MUST** 可区分。
- Log/audit scan 测试使用固定 fake credentials，断言原文不存在，同时保留安全 code/requestId。
