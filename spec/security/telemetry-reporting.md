# XH 遥测上报与中央中继

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：XH owner（接收端契约归 A11/TLM）；来源：PLAN-0522、A11 PLAN-0521；更新：2026-10-15。
> 消费者：UI logger、CP TelemetryController/TelemetryRelayService、A11/TLM 接收端、后续 PLAN

## 1. 范围与边界

- 数据面：UI 结构化诊断事件（closed enum）→ 本机 CP `/api/v1/telemetry/logs` → 本地 `telemetry.log` sink → （可选）实例显式开启的 server-to-server 中继 → A11/TLM `POST /api/v1/telemetry/events`。
- 本地日志（Console/IndexedDB/CP 文件）仍是唯一本地权威；中央副本是 best-effort 旁路，不是业务或审计事实源。
- 明确外送排除：Run Trace、Provider attempt 明细、Chat/Prompt/Response、tool payload、自由文本 message/stack、逐用户身份标识。
- 本 SPEC 不复制 wire schema；TLM wire 以 A11 `docs/api/openapi.yaml` 与 PLAN-0521 契约为准，XH 侧 wire 以本仓库 `docs/api/openapi.yaml` / `inventory.md` 为准。

## 2. 启用与同意

- 中央中继默认关闭；由 XH 实例管理员通过 instance-only `logging.centralTelemetryEnabled`（`"true"`/`"false"`，代码默认 `"false"`）显式开启；不提供逐用户开关。
- 部署侧 `XIHE_TLM_URL` 与 `XIHE_TLM_INGEST_TOKEN` 必须同时存在；任一缺失时 fail-closed 关闭中央副本（本地 sink 不受影响）。令牌只存在于 CP 部署面，永不进入 UI bundle、localStorage 或日志。
- 撤回语义（2026-10-15 用户裁定）：关闭只停止未来上报；不保存逐用户 subject ID，不提供逐用户历史删除；历史事件按 TLM 项目级 retention 策略处理。

## 3. 数据最小化

- V1 仅发送封闭枚举事件（`ui.unhandled_error` / `ui.unhandled_rejection`）与 allowlist 字段（`level`、`errorCode`、`appVersion`）；`errorCode` 是错误名封闭映射（`TypeError`/`ReferenceError`/`RangeError`/`SyntaxError`/`UnknownError`），不是自由文本。
- `eventId` 在事件生成时分配并跨重试/重分批稳定；`batchId` 组批时分配、同批重试复用。
- 服务端边界：CP 入口在写入/转发前执行条数/字段长度/枚举校验；TLM 侧另有独立 body/schema/限流边界（A11 契约）。

## 4. 失败与降级

- UI：单批在途；失败或未登录即丢弃（有界，不阻塞调用方）；pagehide 丢弃未发批次。
- CP：本地 sink 先写；中继 5s 超时、有界队列（256）、队列满丢弃中央副本；失败不改变 `200 {"status":"ok"}` 的含义（该响应只确认本地 sink）。
- TLM 接收契约（幂等键/限额/撤回）以 A11 `spec/ingestion-contract.md` 为准，XH 不复制。

## 5. 现状差距

- 实现状态 `partial`：本 SPEC 随 PLAN-0522 实施落地；真实浏览器 staging 闭环与 TLM 生产部署（PLAN-0521 M3）完成前不得标记 `implemented`。
