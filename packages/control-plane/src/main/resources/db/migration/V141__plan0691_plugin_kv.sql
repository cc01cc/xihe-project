-- PLAN-0691 T1.5 (V141): plugin_kv —— 插件 KV 数据面的存储表。
--
-- 排号：本迁移原定 V138，但 V139/V140 先合入 develop，而本仓 Flyway `outOfOrder=false`
-- （V143 之前未开启），后进的低号会让已迁到 V140 的库直接报
-- "Detected resolved migration not applied to database"，故让位改号 V141（Lead 2026-11-08 裁定）。
--
-- Authority: spec/data-plane.md DP-1（表形状）/DP-6a（**故意不建 FK**）/DP-7（大小与 version 语义）、
-- API-1..API-4、SEC-1..SEC-3、LC-6（宽限期 = 孤儿行存活期）。
--
-- 本表**故意**不建外键（Lead 2026-11-08 裁定 option C，见 spec/data-plane.md DP-6a）：
--   * SEC-2 与 V136 头部注释要求 uninstall 直接**物理删除** binding 行、不留软删占位；
--   * LC-6 与 verify.md V6 要求宽限期内 plugin_kv 行**仍在**；
--   * 两者叠加 ⇒ 数据必须活过 binding 行。若建 ON DELETE CASCADE，宽限期与 V6 直接不可满足；
--     若建 RESTRICT/NO ACTION，卸载删 binding 行会被 DB 拒，且 uq_plugin_bindings_workspace_plugin
--     会让同一插件 7 天内无法重装。
-- 因此宽限期语义落在「孤儿行存活期」上：**删除 binding 行后本表产生孤儿行**，由 T3.2 的 purge job
-- 按「binding_id 在 plugin_bindings 中不存在」且「orphaned_at（未写入时回退 updated_at）超过
-- 604800s」回收；DP-3 的 plugin_index_declarations 永不回收。
-- 代价（已知，不假装它还是 DB 保证）：「binding 存在性」从数据库保证降级为**应用层保证** ——
-- 写入前由 CP 校验 binding 存在且 state = 'enabled'（PluginKvService，SEC-2），purge job 兜底清孤儿。
-- 不要在本表上补 FK 来「修」这一点：那会直接推翻 LC-6/V6/T3.2 三条已冻结条款。
--
-- 本表只有 CP 写（插件经 /internal/v1 数据 API 间接写），插件进程永不直连 DB（verify.md V1）。

CREATE TABLE plugin_kv (
    -- DP-6：插件表只经 binding 关联，禁止混入 workspace_id/user_id 等 CP 业务列。
    binding_id  UUID         NOT NULL,
    -- DP-1 未规定长度；64/256 是 CP 侧护栏（与 manifest kv.namespaces 的命名习惯一致），
    -- 超长在 API 层由 PluginKvService 以 400 INVALID_REQUEST 拒绝，DB 列只做最后兜底。
    namespace   VARCHAR(64)  NOT NULL,
    key         VARCHAR(256) NOT NULL,
    -- DP-7：jsonb 大小在应用层写入前校验（QUOTA-2），不依赖 DB 约束。
    value       JSONB        NOT NULL,
    -- DP-7：version 由 CP 自增，是 CAS（API-9）与幂等（API-10）的唯一来源。
    version     BIGINT       NOT NULL DEFAULT 1,
    -- API-1「过期视为不存在」的判定列；过期行由每小时批删回收。
    expires_at  TIMESTAMPTZ,
    -- DP-6a：T3.2 purge job 的显式时钟（本任务只建列，不写入；uninstall/detach 路径属 T1.4 lane A）。
    orphaned_at TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_plugin_kv PRIMARY KEY (binding_id, namespace, key),
    CONSTRAINT ck_plugin_kv_version CHECK (version >= 1)
);

-- DP-1「主键即点查」：主键已是 (binding_id, namespace, key)，点查/等值前缀由它服务。
--
-- 下面这条是 API-4（前缀列出）的索引，**DP-1 未列**，为满足 API-4 的 `prefix=` 而加：
-- 默认 collation 的 btree 无法服务 LIKE 'p%'，text_pattern_ops 才能把前缀比较压到索引范围扫描。
CREATE INDEX idx_plugin_kv_prefix
    ON plugin_kv (binding_id, namespace, key text_pattern_ops);

-- DP-1「过期清理走 expires_at 部分索引（每小时批删）」：只索引真的有 TTL 的行。
CREATE INDEX idx_plugin_kv_expires_at
    ON plugin_kv (expires_at) WHERE expires_at IS NOT NULL;

-- DP-6a 的 purge 侧扫描入口：孤儿判定 = binding_id 不在 plugin_bindings 且超宽限期。
CREATE INDEX idx_plugin_kv_orphaned_at
    ON plugin_kv (orphaned_at) WHERE orphaned_at IS NOT NULL;
