-- =============================================================================
-- V69 — PLAN-0523 T3.6: llm-provider 层全局采样键退役（决策 #13：无兼容期）
-- =============================================================================
-- 背景：采样参数改为每模型 modelParams map（决策 #9/#12，ProviderHub 就地编辑），
--   层全局 maxTokens/temperature/timeout 三键不再被任何消费方读取
--   （UI ② 表单已随 T3.6 移除；CP schema 同批删除，additionalProperties:false
--   拒绝旧写入；agent from_entries 兼容读取同批退役）。
--
-- 删除目标（llm-provider 域）：
--   maxTokens / temperature / timeout
--
-- 保留：profile / imageProfile（图像全块冻结，决策 #17）/ imageProvider
--   （冻结图像块仍读取）/ modelParams。
--
-- 幂等：无匹配即 0 行；重复执行不产生额外变更。
-- 不触碰：其它域；config_audit 经 fk_config_audit_config ON DELETE CASCADE
--   随被删行清理（V1 既有 schema 行为，与 V13/V67 先例一致）。
-- 回滚：数据不可逆；如需回滚仅能从迁移前 pg_dump 备份恢复。
-- =============================================================================

DELETE FROM config
 WHERE domain = 'llm-provider'
   AND config_key IN ('maxTokens', 'temperature', 'timeout');
