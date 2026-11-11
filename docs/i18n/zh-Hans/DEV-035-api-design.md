---
title: DEV-035 - API 设计标准
category: dev-guide
sidebar_order: 35
lang: zh-Hans
sidebar_group: "开发指南"
status: active
created: 2026-11-11
updated: 2026-11-11
description: XH HTTP REST 面（公开 /api/v1 + 服务间 /internal/v1）的设计标准：路由、认证、错误契约、命名、幂等、分页、长操作、废弃与契约治理。DEV-034 管「四类契约地图」，本文管其中 HTTP 路由这一类的设计规则。
tags:
  - api
  - contract
  - standard
---

# DEV-035 - API 设计标准

> **三态标注**：【已落地】= 现状已如此且有 file:line 实证（见 01-fragments-inventory.md）；
> 【业界建议】= 从 RFC/Zalando/AIP/Microsoft 取经的新增条目；【需裁定】= 与现状冲突或涉及取舍，**归用户**。

## 0. 定位与边界

- 管：CP 暴露的 HTTP REST 面（公开 + 服务间），含错误契约、命名、幂等、分页、长操作、废弃、治理。
- 不管（指向 DEV-034 地图）：SSE 事件 payload 形状（见 xh-event-naming-audit / BL-303）、MCP 协议面（docs/api/mcp-protocol-matrix.md）、持久化/Flyway（packages/control-plane/AGENTS.md §迁移纪律）。
- 与既有文件的关系：**收口而非重写**。碎片分散在 AGENTS.md / DEV-014 / inventory.md，本文是可单点引用的清单；凡与本文冲突的旧表述，以本文为准并回改（落盘时同批处理）。

## 1. 路由与版本

- 【已落地】公开路由统一 /api/v1；服务间统一 /internal/v1；禁止公开 token 混作服务认证（出处 A1/A2）。
- 【已落地】路径段全 kebab-case（openapi 272 条 0 违规）；禁止 camelCase / snake_case 段。
- 【已落地】Route / OpenAPI / inventory / SSE / Flyway 同波次同步，inventory.md 为清单（A3）。
- 【业界建议】版本演进只走「同波次改契约 + UI/CP 同批」，不引入 /v2；当未来必须破坏兼容时，先立 Deprecation 流程（§8）再 fork v2。**理由**：XH 前端随后端同仓同发，URI 版本化的成本大于收益。

## 2. 认证与租户

- 【已落地】user / service 统一 Bearer；服务间禁用户上下文（B1/B2）。
- 【已落地】X-Workspace-Id 权威 header；四类端点豁免清单固定（auth/health/actuator/internal）（B2）。
- 【已落地】错误语义：主体缺失 = 403；已认证缺工作区上下文 = 409 WORKSPACE_CONTEXT_REQUIRED（B3）。
- 【业界建议】凭据与敏感参数**不得出现在 query string**（进 header / body；日志出口已有脱敏，query 会绕过它）。现状未发现违规，立为正向规则。

## 3. 错误契约

- 【已落地】唯一错误格式 = RFC 9457 Problem Details（application/problem+json），形状以 docs/api/problem-details.schema.json 为准（C1/C2）。
- 【已落地】code 模式 ^[A-Z][A-Z0-9_]+$、SNAKE_UPPER；requestId 必填（C2）。
- 【业界建议】type 成员**恒为 "about:blank"**，细分语义全部走 code；不建站点 problem 类型 URI 注册表（YAGNI，单应用无多服务共类型需求）。**解决缺口 G6**。
- 【业界建议】title 用该 status 的标准短语（RFC 9457 SHOULD），detail 写人能读的修复提示；机器分支只认 code + status。**解决缺口 C5 的一半**（instance 成员继续不用，文档显式说明理由）。
- 【已裁定·待排期】**错误码集中登记**（用户 2026-11-11 批）：把散在 DEV-014/inventory 散文里的全部 code（WORKSPACE_CONTEXT_REQUIRED、BRANCH_RUN_MISMATCH、FOLLOW_UP_QUEUE_NOT_EMPTY、BRANCH_LOCK 等）收进本文附录码表，openapi 按端点引用。落盘时先建表，DEV-014 改引用随窗口排期。

## 4. 命名与数据格式

- 【已落地】自有 JSON camelCase；协议定义 JSON 原样（D1）。
- 【已落地】内部字段（pid/policyPath/mxcTier 等）不得透传公开面（A5）。
- 【业界建议】时间一律 RFC 3339 / date-time（Z 后缀）；ID 类字段 uuid 格式；URL 字段 uri 格式（Zalando [168]）。新增字段照此，存量不动。

## 5. 幂等与重试

- 【已落地】写操作幂等用 Idempotency-Key header（现状 17 处：jobs start / workspaces 创建 / guidance）（E1）。
- 【业界建议】统一三条：① 幂等键只对**写**端点是 MUST，读端点禁止要求；② 键冲突且 body 不同 = 409，body 相同 = 返回首次结果（现状语义保持，写成明文）；③ 键有效期（建议 24h）写进文档，防止「同键隔月复用」歧义。

## 6. 分页与过滤

- 【需裁定】**统一分页参数**。现状 4 种名混用：cursor×1 / limit×2 / page×1 / size×1（G1）。
  - 方案甲（对齐 AIP-158）：page_size + page_token（opaque），可选 skip。Offset 语义友好。
  - 方案乙（对齐 Zalando [159]）：limit + cursor（opaque），前进-only。实现最简。
  - **裁定（用户 2026-11-11，Lead 转达）：选方案乙（limit + cursor）**。既有 4 处端点改名是破坏性批次，随 DEV-035 落盘后按窗口排期，同波次改 UI/CLI/测试。
- 【业界建议】filter/sort/fields 查询参数**暂不开放**（YAGNI；现有 24 个参数无此需求）；未来需要时按「集合端点专用节」补，不进通用规范。

## 7. 长操作（LRO）

- 【已落地】异步提交 202 + runId/jobId（chat 202、openapi 202 共 14 处）（E2）。
- 【业界建议】收口成一条明文：POST 可能长跑 ⇒ 202 + 轮询 GET 同一资源直到 terminal 状态；**不得**用 200 + 体内 status 字段伪装同步。SSE 通知只是旁路加速，不是状态权威（与 DEV-014 jobs 节一致，写死）。

## 8. 废弃与演进

- 【业界建议】废弃三步：① openapi 标记 deprecated: true；② 响应加 Deprecation: @<http-date> 与 Sunset: <http-date> 头（RFC 9745 语义）；③ 到期删除同波次改消费者。现状 0 处规范（G3）。
- 【业界建议】本文自身修订走「同波次改 + 台账 D 号」，因为它就是契约的一部分（A3 规则的自我引用）。

## 9. 契约治理

- 【已落地】openapi.yaml 唯一 SSOT、人工维护；代码背离改代码（F1）。
- 【已落地】运行时原生文档（/v3/api-docs、/openapi.json）降级为调试产物（F2）。
- 【已落地】四门：check:openapi / check:openapi:lint / check:api-docs / check-api-types-drift（F3）。
- 【业界建议】新增端点 checklist 落进本文附录（路由段 kebab → openapi 先写 → 门绿 → inventory 登记 → DEV 编号同步），把 A3 的「同波次」从口号变步骤。

## 10. 冲突清单（**不自裁，归用户**）

| # | 草案条目 | 与什么冲突 | 取舍说明 |
| --- | --- | --- | --- |
| 9-1 | §1 保留 /api/v1 前缀 | Zalando [135] SHOULD not use /api | **裁定 2026-11-11：维持现状** |
| 9-2 | §3 平铺 RFC 9457 形状 | Microsoft ARM 嵌套 error / Google google.rpc.Status | **裁定 2026-11-11：维持现状**（XH 已全面实现平铺，7 个 Controller） |
| 9-3 | §6 统一分页参数 | 既有 4 端点的 cursor/limit/page/size | **裁定 2026-11-11：方案乙**（limit + opaque cursor）；改名破坏性批次随落盘后排期 |
| 9-4 | §3 错误码集中登记 | 码表散在 DEV-014 / inventory 散文（openapi 仅枚举 3 个，真实几十个） | **裁定 2026-11-11：登记**；连改三处（DEV-014 引用本文 / openapi 挂 code / DEV-034 地图联动）随窗口排期 |
| 9-5 | §8 Deprecation/Sunset 头 | 现状 0 处规范 | **裁定 2026-11-11：维持现状（不引入）**；废弃通知继续走 DEV-014/交接档口径，未来若接外部开发者再重开 |

## 附录 A · 新端点 checklist（草案，随落盘生效）

1. 路径段 kebab-case，挂正确 tag；2. openapi.yaml 先写（SSOT 先行）；3. redocly lint + validate 绿；
4. 错误响应挂 schema 引用；5. inventory.md 登记；6. DEV 编号（中英双侧）同批；7. UI 四层同波次（packages/ui/AGENTS.md:52）；8. 需要页内 fetch 的 e2e 加标注。

## 附录 B · 证据索引

- 调研证据（task-126 三件套）：`plans/PLAN-0763-XH-api-contract-docs/evidence/task-126-dev-035/`（碎片清单 / 业界来源 / 复算命令）
- 裁定批次：D-909（2026-11-11）
