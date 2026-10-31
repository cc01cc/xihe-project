-- =============================================================================
-- V85 — PLAN-0580 实例所有权（多 ADMIN + 单例 instance_owner）与 access token epoch 列
-- =============================================================================
-- 目的：把「唯一 admin」从事实（seeded）升级为约束（409 LAST_ADMIN），并给实例一个
--   单例 owner 指针（可转移、不可降级），同时为 access token 增加 epoch 列
--   （users.token_version），使角色变更对既有 token 即时生效。
--
-- 依据：plans/PLAN-0580-XH-instance-ownership/spec/migration-v85.md（2026-10-31 冻结）。
--   · 单例表形式对齐 V21__policy_revision_counter.sql:24,25,28-30（命名 PK / CHECK id=1 /
--     INSERT … SELECT … WHERE NOT EXISTS 的 PG+H2 双方言写法）。
--   · assigned_by 用 ON DELETE SET NULL（责任事实源是 assigned_at + 审计行）；
--     owner_user_id 保持 ON DELETE RESTRICT（owner 不可被删除，I3）。
--   · 回填取最早 ADMIN，排序键 ORDER BY created_at, id（users.created_at 是
--     DEFAULT NOW() = 事务时刻，同事务多行相等 → 必须 id tie-break，先例 V82:29）。
--     无 ADMIN / 空库则 0 行受影响，owner 留空由 DataSeeder 或 localMode 首次注册指派。
--
-- 顺序门：Flyway out-of-order 未开启（application.properties 无该键），V86 必须在 V85 之后。
-- 回滚：DROP TABLE instance_owner; ALTER TABLE users DROP COLUMN token_version;
--   （回滚会丢 epoch 能力与 owner 记录，见 spec §6）
-- =============================================================================

CREATE TABLE instance_owner (
    id            SMALLINT                 NOT NULL,
    owner_user_id UUID,
    assigned_at   TIMESTAMPTZ,
    assigned_by   UUID,
    created_at    TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_instance_owner PRIMARY KEY (id),
    CONSTRAINT ck_instance_owner_singleton CHECK (id = 1),
    CONSTRAINT ck_instance_owner_consistency CHECK ((owner_user_id IS NULL) = (assigned_at IS NULL)),
    CONSTRAINT fk_instance_owner_user FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_instance_owner_assigned_by FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE SET NULL
);

INSERT INTO instance_owner (id)
SELECT 1
WHERE NOT EXISTS (SELECT 1 FROM instance_owner WHERE id = 1);

ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

-- 回填：最早的 ADMIN 成为首任 owner（确定性：created_at, id；仅当 owner 仍为空）。
UPDATE instance_owner o
SET owner_user_id = c.id,
    assigned_at   = NOW(),
    assigned_by   = NULL,
    updated_at    = NOW()
FROM (
    SELECT id
    FROM users
    WHERE role = 'ADMIN'
    ORDER BY created_at, id
    LIMIT 1
) AS c
WHERE o.id = 1
  AND o.owner_user_id IS NULL;
