# XH 工具能力门契约（Tool Capability Gate）

> 契约状态：`active`（由 PLAN-0591 冻结）；实现状态：`implemented`；Profile：`protocol`；Owner：CP Provider/Agent LLM 联合作者；来源：PLAN-0591（BL-149）；更新：2026-10-31。
> 消费者：CP Provider catalog/Connection、Agent LLM 发送路径、UI ProviderHub、后续工具/模型能力相关 PLAN。

## 1. 判定源

- 工具是否允许发往某个 provider 路由，MUST 只由 `provider-catalog/providers.json` 的 `supportedApiTypes[].capability.tools` 决定，粒度是 `(providerId, apiTypeId, version)`。
- `capability.tools` 缺失 MUST 视为「不支持」，并在加载期产生 WARN（不静默放行）。
- provider 级 `supports.tools` 是本 provider 各 apiType 的 `any` 汇总，仅作展示；`supports.toolsPartial` MUST 满足 `any && !all`，用于表达混合态（部分 apiType 支持工具）。
- `catalogRevision` MUST 在引入 per-apiType 能力时从 `v1` 升到 `v2`；`v2` 的语义是「新增 per-API-Type `capability` 与 provider 级 `toolsPartial`」，不改变既有 `v1` 字段含义。

## 2. 门的位置与次序

- Agent 发送路径的次序 MUST 为：模板渲染 → `validate_body` → **capability gate** → `begin_attempt()`（`packages/agent/src/xihe_agent/llm/api_sender.py:425-432`）。
- 当渲染后的请求体 `tools` 非空而该路由 `capability.tools=false` 时，MUST 以稳定终态码 `LLM_TOOL_ROUTE_UNSUPPORTED` 失败，且：
  - MUST NOT 发起任何 provider 出网（传输尝试数 `attempt=0`）；
  - MUST NOT 产生 `tools/call`、MUST NOT 写文件、MUST NOT 生成 assistant 内容；
  - MUST NOT 静默改用其他 apiType/provider（无隐式路由切换）。

## 2a. Vision 渲染顺序（PLAN-0605；M2 裁定 B：渲染器后置变换）

- 顺序 MUST 为：模板渲染 → `validate_body` → 能力门（`tools` 门、`vision` 门）→ **渲染器变换** → `begin_attempt()` → 出网。
- 渲染器变换 MUST 同时满足三个条件才生效：`images` 非空、该 `apiTypeId` 在 `VISION_RENDERERS` 内、本轮存在 `role=user` 消息。
- 变换范围 MUST 仅限**本轮最后一条 user 消息**：`content` 由字符串改写为 `[{type:"text",text:<原字符串>}, {type:"image_url",image_url:{url:"data:<mime>;base64,…"}}…]`；**原文本 MUST 逐字保留**，其它消息与字段 MUST 原样透传。
- 字节来源 MUST 唯一：Agent 凭 `runId` 调 CP 内部路由 `GET /internal/v1/attachments/{id}/content?runId=`（run/workspace/attachment 三元归属 + lease 已 redeem）；字节 MUST 只在内存中组装 data URL，MUST NOT 落盘、MUST NOT 进日志/SSE/DB/审计。
- 取字节失败（403/404/413/超时/网络）MUST 以稳定码 `LLM_VISION_ATTACHMENT_UNAVAILABLE` 失败，**MUST NOT 静默降级为纯文本请求**（降级即本门要修的缺陷形态）。
- 模板本身 MUST 保持纯文本槽位；本变换属 apiType 渲染器职责，不新增模板变量、不改快照校验规则。
## 3. 不受门禁的路径

- `tools` 为空（纯文本）的请求 MUST NOT 被该门拦截。
- `tools=[]` 时即使带 `tool_choice` 等字段，本门 MUST NOT 新增校验；若 provider 拒绝，错误码归 `LLM_REQUEST_REJECTED`（条件式，取决于 provider 行为）。

## 4. 终态与可观测

- 拒绝 MUST 走 **SSE `200` + `error` 事件** 路径（`event:error {code:"LLM_TOOL_ROUTE_UNSUPPORTED"}` 与 `event:done {outcome:"error", errorCode:...}`），MUST NOT 被折叠成 HTTP ≥400 的 `safeErrorCode` 归一。
- 终态 MUST 同时落 `chat_runs`（`status=failed`, `error_code`）与 `chat_run_history`（`terminal`, 同码），且审计读面 `GET /api/v1/audit/entries?type=chat_run` 可见同一错误码。
- 每个 `supportedApiTypes[]` 条目的能力数据 MUST 带证据指针（登记在 `packages/control-plane/src/main/resources/provider-catalog/README.md`）；`providers.json` MUST 保持严格 JSON（禁止注释与 `_comment` 字段）。

## 5. 混搭版本与支持路径

- 混合版本矩阵（provider 支持 / apiType 支持 / version 支持 / 缺字段）四组合 MUST 各自有确定结论；非法组合 MUST fail-fast（加载期报错，不落半可用状态）。
- 当 `capability.tools=true` 时，工具 MUST 真实执行：Agent MAY 发起带 tools 的 provider 请求，工具调用 MUST 经 MCP `tools/call` 落到工作区并留下可核对的 `mcp_invocations` 记录与文件产物。

## 6. 非目标

- **模型级能力**（同一 apiType 下个别模型不支持工具）不在本契约内：由 provider 400 → `LLM_REQUEST_REJECTED` 兜底，单独 backlog（见 `DEV-018`）。
- **多模态图像输入**不在本契约内，且当前**未实现**：Agent 侧无「附件 → 图像 content part」渲染路径（`git grep -rni 'attachment' -- packages/agent/src` = 0 命中；CP 只把附件引用序列化为 `attachmentsJson` 转给 Agent）。这属功能缺口而非本门回归，建议单独立 BL/PLAN。

## 7. 变更流程

- 翻转任一 `capability.tools`（含 `supports.tools`/`toolsPartial` 联动）MUST 附带证据指针，且 MUST 为纯数据变更 + `catalogRevision` 语义复核，不得与逻辑改动混在同一提交。
- 翻转触发条件：厂商/模型宣称支持工具、注册新 apiType 或版本、出现工具相关 provider 400、季度复核到期。触发后 MUST 先按 PLAN-0591 `evidence/m0-hypotheses.md` 的 E2/E3 实验区分「provider 忽略 tools」与「模型本轮不调用」；真实调用至多 1 次、须用户书面批准、不 retry、不用于判定 H1/H2。

## 8. 判据与证据

- 关闭判据（BL-149）：显式失败 / 0 出网 / `attempt=0` / 0 `tools/call` / 0 文件 / 支持即执行 / 真实预算合规 / 模型级残余已登记。
- 证据：`plans/PLAN-0591-XH-provider-tool-capability/evidence/` 下 `v1-fail-closed.md`、`v2-support-executes.md`、`v3-capability-matrix.md`、`v4-text-path.md`、`v6-ui.md`、`v7-audit.md`、`m3-e2e-verification.md`、`m4-real-lane.md`、`m5-bl149-closeout.md`。

