-- PLAN-0497 T1.1 (contract: 0497 design §方案 1 / decisions #1/#2/#8, I1/I2):
-- 通用凭据租约——单次 + TTL + 绑定五元组（credential/principal/session/run/workspace）
-- 不可缺项（I1）；token 只存 SHA-256（I2，lease_hash 唯一）；expected_revision 对齐
-- 0495 credentials.revision（签发时点快照，redeem 时校验）。
-- 不复用 provider_credential_leases：域绑定字段不同，合并会产生可空列（0497 #1）。
-- 不含 revoked_at：v1 无撤销端点，TTL 自然收敛（0497 #8）。
-- * Reversible: DROP TABLE credential_leases（仅新表，无数据迁移）。

CREATE TABLE credential_leases (
    id                UUID PRIMARY KEY,
    lease_hash        VARCHAR(64)  NOT NULL,
    credential_id     UUID         NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
    principal_id      UUID         NOT NULL,
    session_id        UUID         NOT NULL,
    run_id            UUID         NOT NULL,
    workspace_id      UUID         NOT NULL,
    expected_revision INTEGER      NOT NULL,
    expires_at        TIMESTAMPTZ  NOT NULL,
    redeemed_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_credential_leases_revision CHECK (expected_revision >= 1)
);

-- I2: the token exists only as its hash; one row per token.
CREATE UNIQUE INDEX uq_credential_leases_hash
    ON credential_leases (lease_hash);

-- TTL sweeps / expiry lookups.
CREATE INDEX idx_credential_leases_expires
    ON credential_leases (expires_at);

-- Per-credential lease history (issue/redeem audits, future redaction sweeps).
CREATE INDEX idx_credential_leases_credential
    ON credential_leases (credential_id);
