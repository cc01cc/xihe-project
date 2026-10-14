-- PLAN-0495 T1.1 (contract: PLAN-0494 design #4/#5/#8 + PLAN-0495 design §方案 1/5):
-- 凭据管理器基础域——credentials（对象 + 密文 + 生命周期）与 credential_events
-- （域审计存储；0497 M3 审计读面的数据源）。
--
-- * owner 两级模型 WORKSPACE > USER（0494 #5）；owner_type 值域对齐
--   provider_connections 但有意不含 SYSTEM。
-- * kind = token | key_pair（0494 #6 v1 形态）；delivery_tier = lease | reveal
--   单通道语义（0495 #10）；broker 仅文档预留、写入层拒绝（0495 #9），
--   CHECK 不放行 broker。
-- * status = active | disabled（0495 #8）；删除 = deleted_at 软删位。
-- * revision 单调（replace 时 +1；rotate 不改内容、不 bump——0495 #7a）——
--   0497 租约以 expected_revision 绑定该列（TOCTOU 保护）。
-- * secret_ciphertext 为整体加密的 JSON 载荷（token 或 access/secret 对，
--   0495 #2）；fingerprint 为不可逆展示/去重辅助；两者永不落值。
-- * credential_events 永不落值；event_type 覆盖全部生命周期动作（0495 §方案 5，
--   交付类事件由 0497 写入）。actor 约定：<user-uuid> / agent:<principal-uuid> / system。
-- * 可回滚：DROP TABLE credential_events, credentials（仅新表，无数据迁移）。

CREATE TABLE credentials (
    id                UUID PRIMARY KEY,
    owner_type        VARCHAR(16)  NOT NULL,
    owner_id          UUID         NOT NULL,
    label             VARCHAR(128) NOT NULL,
    kind              VARCHAR(16)  NOT NULL,
    delivery_tier     VARCHAR(16)  NOT NULL,
    status            VARCHAR(16)  NOT NULL,
    revision          INTEGER      NOT NULL DEFAULT 1,
    secret_ciphertext TEXT         NOT NULL,
    fingerprint       VARCHAR(64)  NOT NULL,
    key_version       VARCHAR(16)  NOT NULL,
    created_by        UUID,
    replaced_at       TIMESTAMPTZ,
    rotated_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ,
    CONSTRAINT ck_credentials_owner_type CHECK (owner_type IN ('USER', 'WORKSPACE')),
    CONSTRAINT ck_credentials_kind CHECK (kind IN ('token', 'key_pair')),
    CONSTRAINT ck_credentials_delivery_tier CHECK (delivery_tier IN ('lease', 'reveal')),
    CONSTRAINT ck_credentials_status CHECK (status IN ('active', 'disabled')),
    CONSTRAINT ck_credentials_revision CHECK (revision >= 1)
);

-- existsForOwner / 列表：仅活跃行
CREATE INDEX idx_credentials_owner_active
    ON credentials (owner_type, owner_id)
    WHERE deleted_at IS NULL;

-- 轮换作业：按密钥版本计数/分批（全表，含软删行）
CREATE INDEX idx_credentials_key_version
    ON credentials (key_version);

CREATE TABLE credential_events (
    id            UUID PRIMARY KEY,
    credential_id UUID         NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
    event_type    VARCHAR(32)  NOT NULL,
    actor         VARCHAR(64)  NOT NULL,
    owner_type    VARCHAR(16)  NOT NULL,
    owner_id      UUID         NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_credential_events_type CHECK (event_type IN (
        'created', 'replaced', 'deleted', 'lease_issued', 'lease_redeemed', 'revealed'))
);

-- 读面主查询：单凭据时间序（0497 M3 全局序如需另加索引）
CREATE INDEX idx_credential_events_credential_created
    ON credential_events (credential_id, created_at DESC);
