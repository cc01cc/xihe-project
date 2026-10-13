-- PLAN-0496 round-4：每个 subject 至多一行 direct grant——绑定路径合并写入既有
-- source='direct' 行；缺少该围栏时两个并发的首次绑定会各自 INSERT 一条 direct 行
-- （findFirst 变为非确定，unbind 只清其中一行 → 另一行残留原子且审计已记 removed）。
-- 对齐 V38 为 source='default' 建立的 partial unique index 模式；冲突在
-- CredentialBindingService 映射为 409 DIRECT_GRANT_CONFLICT（幂等重试）。
--
-- * Reversible：DROP INDEX uq_grants_direct_subject（索引可重建）。

CREATE UNIQUE INDEX uq_grants_direct_subject
    ON grants (subject_type, subject_id)
    WHERE source = 'direct';
