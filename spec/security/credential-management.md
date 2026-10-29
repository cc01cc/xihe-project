# XH 凭据管理

> 契约状态：`proposed`；实现状态：`partial`；Profile：`security`；Owner：Security（授权/审计）+ CP ConfigService（存储/密钥）；来源：PLAN-0495（承接 PLAN-0494 决策基线 22 条）、PLAN-0576（AAD v2 / HMAC 指纹 / 迁移）；更新：2026-10-28。
> 消费者：CP 凭据域（存储/生命周期/轮换）、PLAN-0496（授权接入与 API）、PLAN-0497（交付通道）、PLAN-0498（UI）、运维轮换（internal rotation runs）。
> 实现状态说明：存储、生命周期与轮换（PLAN-0495 M1–M3）、授权接入与管理 API（PLAN-0496 M1–M3）、交付通道（PLAN-0497 M1–M3：租约交付、工具获取、reveal、事件读面）已实现并验证；PLAN-0576 的 V84 schema、AAD v2、HMAC 指纹与迁移作业已实现并测试，**真实环境迁移（T3.5）待停写窗口另行执行**；UI（0498）未实现——本节所有 `MUST` 均为目标契约，不得当作当前运行事实。

## 1. 范围与边界

- 凭据管理域（credential manager）承载 owner 级独立凭据对象：登记、加密存储、生命周期与密钥轮换。
- 本域对象与 provider connections 的关系（PLAN-0553 supersede）：`provider_connections` 不再保存 `credential_ciphertext`，只保存 owner-neutral 的 `credential_id` 引用；provider lease/verify/export 经本域解密，link 与 use 分别受 `credential_use`/`credential_manage` 约束。MCP OAuth 仍保持独立、不迁移。本文件继续与 `spec/protocol/provider-api-types.md` 的 Credential Boundary 交叉引用，但连接侧边界已由 PLAN-0553 更新。
- owner 两级：`WORKSPACE > USER`（`owner_type` 值域 `USER` / `WORKSPACE`；不含 `SYSTEM`）。
- v1 形态：`kind` 仅 `token` 与 `key_pair`；`delivery_tier` 仅 `lease` 与 `reveal`（单通道语义）；`broker` 为预留枚举值——**MUST** 在写入层被拒绝。

## 2. 对象与不变式

`credentials` 行字段：`id`、`owner_type`/`owner_id`、`label`、`kind`、`delivery_tier`、`status`（`active`/`disabled`；删除=软删位）、`revision`（单调，replace 递增；rotate 不改内容、不 bump——内容版本语义）、`secret_ciphertext`（单字段 JSON 载荷整体加密：token 或 access/secret 对）、`fingerprint`、`key_version`、`aad_version`（`1`/`2`）、`fingerprint_version`（`sha256`/`hmac-sha256-v1`）、`created_by`、`replaced_at`/`rotated_at`、时间戳与软删位。`credential_events` 为域审计存储（event_type/actor/owner/时间；永不落值）。

- I1：密文行与元数据 **MUST** 同行事务写入；加密域不可用时登记失败。
- I2（PLAN-0576）：AAD 版本化——新写 **MUST** 使用 v2：`v2|credentialId|ownerType|ownerId|kind|revision|keyVersion`，与 `aad_version=2` 同时写入（不得依赖列默认值）；旧行以 `aad_version=1` 保持 `credentialId|ownerType|ownerId` 可解；`aad_version` 不是 1/2 时 **MUST** 显式失败，不猜测/不回退。AAD 取值顺序：create 用 `revision=1`；replace 用 `revision+1` 且先取 `keyVersion=current`。
- I3：轮换 **MUST NOT** 改变 credential id；replace 保 id 且 `revision` +1。
- I4：删除前 **MUST** 可产出引用报告（反查 grants 由 0496 提供查询，作业编排归本域）。
- I5：明文只存在于解密调用栈内，**MUST NOT** 写入任何持久面（日志、审计、DB 非密文列、响应）。
- I6：所有加解密 **MUST** 经 `CredentialEnvelope` 单一入口；禁止在调用点散落 AAD 拼装。
- **fingerprint**：不可逆展示/去重辅助。新写 **MUST** 为 `HMAC-SHA256(cp.credentials.fingerprint-key, canonical)` 的 64-hex，`fingerprint_version='hmac-sha256-v1'`；canonical 与旧实现一致（token 或 `accessKey + "\n" + secretKey`），由 `CredentialSecretCodec` 单一实现。旧行 `fingerprint_version='sha256'` 仍可读/可审计，迁移后改写为 HMAC。不含明文与后缀；展示截断归 UI。
- 威胁模型（PLAN-0576 决策 #8）：AAD v2 只阻止“仅改 `secret_ciphertext` 列”的拼接/回滚（旧 revision、另一 kind、另一 keyVersion、另一 owner）；能同时改元数据列的对手需整行签名，不在本契约范围。

## 3. 密钥纪律

- 单层 AES-256-GCM（`EnvelopeEncryptionService`），密文格式 `version:nonce:ciphertext`；不引入 KEK/DEK——触发升级的条件是云 KMS/多租户/合规要求。
- 独立主密钥 `cp.credentials.encryption-key`；key ring 配置 `cp.credentials.key-ring`（JSON `{version: base64 key}`）+ `cp.credentials.current-version`；环**MUST** 包含 current 版本，缺则启动失败。
- 独立指纹密钥 `cp.credentials.fingerprint-key`（base64 32 bytes，PLAN-0576）**MUST NOT** 复用加密 key/环：用于 HMAC-SHA256 指纹，避免跨协议 key reuse。prod 缺 `XIHE_CP_CREDENTIALS_FINGERPRINT_KEY` 时 fail-fast（`SecurityDefaultsValidator`）；dev 未配置时使用固定公开常量派生并 WARN，不得用于真实凭据。指纹 key 轮换不在本计划，版本值已预留 `hmac-sha256-v2`。
- dev 派生 key 必须显式允许（`cp.credentials.allow-dev-key`）；prod 未配置 key/ring 或 `allow-dev-key=true` 时 fail-fast 拒绝启动。
- **单版本部署**：V84 应用后旧 CP 因缺少 migration 被 Flyway validate 拒绝，且 v2 行旧代码无法解密。停写窗口 = 从正式备份开始，到 V84 + 新 CP 启动结束；之后迁移可在线分批执行。回滚唯一路径是恢复“V84 前 + 停写后”的备份，备份后的新写入会丢失；反向迁移 v2→v1 不在契约内。

## 4. 生命周期

- create：校验 owner/kind/tier/secret → 生成 id → 加密（AAD 绑定）→ 同事务写行 + `created` 事件 + AuditLogger。
- replaceSecret：保 id；重加密并重算 fingerprint；`revision` +1；写 `replaced_at`；`replaced` 事件。
- delete：软删 + `deleted` 事件；引用报告由 0496 反查 grants（I4）。
- 悬空校验（0496 消费，签名冻结）：`existsForOwner(ownerType, ownerId, credentialId)` 为纯查询布尔——malformed/不存在/他人 owner/软删 → `false`；调用方将 `false` 映射为自身校验错误。

## 5. 轮换与 crypto 迁移（key ring rotation + PLAN-0576）

- 两类待迁移行：`key_version != current`（既有轮换），或 `aad_version != 2` / `fingerprint_version != 'hmac-sha256-v1'`（本契约迁移）。两者由同一作业处理。
- 扫描 **MUST** 用 id 游标（`id > lastId AND deleted_at IS NULL`，按 id 升序），单次运行在服务内部循环分页直到游标结束；**不得**恒取 page0。软删行跳过，不重加密、不复活。
- 每条：按 `row.aad_version` 解密（`CredentialEnvelope`）→ 用当前 `keyVersion` + v2 AAD 重加密 → `CredentialSecretCodec` 从 JSON 明文重算 HMAC → CAS 写回 `secret_ciphertext`、`key_version`、`aad_version=2`、`fingerprint`、`fingerprint_version='hmac-sha256-v1'`、`rotated_at`。
- CAS **MUST** 以「读取时的密文 + `deleted_at IS NULL`」为条件：replaceSecret 与轮换/迁移互不覆盖，已删除行不得被写回。
- 失败分类仅本次运行：解密失败/未知 AAD 版本/持续 CAS 冲突记 `unmigratable`（逐行 id + reason 日志/evidence），**不新增持久化状态列**；游标必须跨过失败行，不设失败上限（失败上限会让尾部行永远到不了），后续运行会重试。
- 运行记录审计只含批次/条数/结果与 unmigratable id，不含值。
- 作业入口：internal `POST /internal/v1/credentials/rotation/runs`（Bearer service auth）。**不得**用 `xihe credential rotate` 判定迁移完成——CLI 的 `pendingTotal` 只统计 key 版本，会漏掉 AAD/指纹迁移并误判收敛。
- 终止判据：一次“到达游标末尾”的运行满足「可迁移行 = 0 + 不可迁移行有本次运行 id 证据」；被中断/未到末尾的运行不算。旧 key 退役仍按 `key_version` 计数为 0 判定，不按总迁移计数。
- `CredentialRotationStatus`/internal wire **MUST NOT** 因迁移新增字段；迁移计数走只读 SQL/evidence 与日志。

## 6. 审计

- 动作 `credential_created` / `credential_replaced` / `credential_deleted` / `credential_rotated`；detail 只含 id、owner、kind、tier 与 fingerprint；明文与后缀一律不入。
- 域事件落 `credential_events`（`created`/`replaced`/`deleted` + 0497 交付事件；轮换/迁移为批次级审计，不逐行写事件）。
- PLAN-0576 迁移审计：批次审计仍为 `credential_rotated`（migrated/conflicts/failures/remaining/targetVersion，不含值）；本次运行的 unmigratable 行只以 id + reason 写应用日志（evidence 用途），不新增持久化审计/状态列。
- 交付与 reveal 的审计注记归 0497（`security/audit.md` 消费注记）。0497 动作：`credential_lease_issued` / `credential_lease_redeemed`（actor `agent:<principalId>`，与租约行同事务）与 `credential_revealed`（actor `user:<userId>`，成功）；step-up 失败记 `credential_reveal_failed`（只入 AUDIT 流，不写域事件行）；以上均不含值。
- 审计读面（0497 M3，供 0498）：`GET /api/v1/credentials/{id}/events` 返回 owner 可见的 `credential_events` 轨迹（eventType/actor/时间，无值）；交付动作同时写域事件行与 AUDIT 流。

## 7. 交付边界（v1）

- 密文只经受控交付通道离开存储：`lease` 档仅一次性租约；`reveal` 档仅 step-up reveal（`no-store`）；两通道均以 grant 求交，缺 grant fail-closed；细节归 0497 交付契约。
- Agent 获取通道：CP-owned 工具 `acquire_credential`（tool-call 边界完成 `credential_use` 求交与既有 ask 审批）；CP handler 内一步完成租约签发 + 单次兑换 + 解密交付；明文只进 Agent 进程内存，durable `tool.result` preview 与 SSE `tool_result` 以占位替换，模型本轮 ToolMessage 保留。
- `reveal` 为例外通道：仅限 reveal 档凭据、必须经 step-up（重输登录密码）与失败限流（进程内 5 次/15 分钟）、响应 `no-store` 且仅本次明文；审计 `credential_revealed` 可区分且不含值；v1 不接 ask（不建 pending approval）；不得扩展为通用读。
- `broker` 预留：档位语义为服务端注入、消费方只持引用（不经第三方注入代理、不把明文交给消费方内存）；出现「凭据必须不经任何消费方内存」的真实场景时再评估。

## 8. 承接与消费者

- PLAN-0496：授权接入与管理 API（`/api/v1/credentials`）；消费 §2/§4 语义与 `existsForOwner` 契约；更新 `principal-workspace-scope.md`。
- PLAN-0497：交付通道（工具获取、租约、reveal、审计读面）。
- PLAN-0498：UI（登记/列表/绑定/reveal 视图）。
- PLAN-0576：AAD v2、HMAC 指纹、V84 schema 与 crypto 迁移作业（§2/§3/§5）。
- 运维：轮换/迁移（§5）。
- provider/OAuth 两域仍为单 key；本域轮换能力**不**自动扩展到两域（后续承接）。

## 9. 未决与风险

- `SYSTEM` owner 与 AGENT owner 未定（后置评估）。
- 生产级轮换窗口与批次参数在真实数据规模下复核；轮换首次演练已由 PLAN-0495 M3 完成（两版本环 + 退役计数为零的集成证据）。
- PLAN-0576 的真实环境迁移（T3.5）尚未执行：须先由用户确认停写窗口、重取正式备份，再按 §5 终止判据运行；执行前不得宣称已收敛。
- 已迁移行仍需旧 key 留存至退役校验通过；退役前不得从环中移除旧 key。
