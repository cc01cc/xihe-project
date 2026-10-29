-- PLAN-0576 T1.1 (contract: PLAN-0576 design §AAD v2 / §fingerprint v2, decisions #1/#2):
-- 凭据密文上下文绑定（AAD）与展示指纹的版本化。
--
-- * aad_version = 1：继承 PLAN-0495 的 AAD `credentialId|ownerType|ownerId`；
--   存量行全部落 1（列默认值，不在 SQL 层改写/回填）。
-- * aad_version = 2：`v2|credentialId|ownerType|ownerId|kind|revision|keyVersion`；
--   新写（create/replace）一律 2，旧行由轮换作业迁移（PLAN-0576 M3）。
-- * fingerprint_version = 'sha256'：PLAN-0495 的裸 SHA-256 指纹（legacy）；
--   'hmac-sha256-v1'：独立 fingerprint key 的 HMAC-SHA256，新写一律该版本。
-- * 版本列只服务 CP 内部解密分派与迁移，不进入公开 API/OpenAPI。
-- * 增量迁移：只加列与 CHECK，无数据改写；回滚 = DROP COLUMN（新写入丢失，
--   正式回滚见 PLAN-0576 design §部署与回滚）。
-- * 迁移扫描索引（T1.1）：M3 查询为 id 游标 + deleted_at + 三版本 OR，
--   主键 btree 已提供 id 范围与顺序；三版本 OR 无法被单个部分索引覆盖，
--   迁移期选择性低，故不新增索引（理由见 evidence/m3-migration.md）。

ALTER TABLE credentials
    ADD COLUMN aad_version SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN fingerprint_version VARCHAR(32) NOT NULL DEFAULT 'sha256';

ALTER TABLE credentials
    ADD CONSTRAINT ck_credentials_aad_version CHECK (aad_version IN (1, 2));

ALTER TABLE credentials
    ADD CONSTRAINT ck_credentials_fingerprint_version
        CHECK (fingerprint_version IN ('sha256', 'hmac-sha256-v1'));
