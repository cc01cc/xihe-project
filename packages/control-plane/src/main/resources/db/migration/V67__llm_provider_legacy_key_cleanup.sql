-- =============================================================================
-- V67 — PLAN-0504: llm-provider 默认身份迁移到 profile 整单元（决策 #2：无兼容期）
-- =============================================================================
-- 背景：llm-provider 的默认身份改为整单元 `profile`
--   （{"providerId","connectionKey","model"}，见 config-schemas/llm-provider.json）；
--   13 个 legacy 键不再被任何消费方读取（CP/Agent/UI 同批退役），按无兼容期原则删除。
--
-- 删除目标（llm-provider 域）：
--   defaultProvider / defaultModel / baseUrl /
--   openaiModel / openaiApiBase / deepseekModel / deepseekApiBase /
--   xiaomiModel / xiaomiApiBase / anthropicModel / anthropicApiBase /
--   dashscopeModel / dashscopeApiBase
--
-- 幂等：无匹配即 0 行；重复执行不产生额外变更。
-- 不触碰：其余键（profile/imageProvider/maxTokens/temperature/timeout）与其它域；
--   config_audit 经 fk_config_audit_config ON DELETE CASCADE 随被删行清理
--   （V1 既有 schema 行为，与 V13 先例一致）。
-- 回滚：数据不可逆；如需回滚仅能从迁移前 pg_dump 备份恢复。
-- =============================================================================

DELETE FROM config
 WHERE domain = 'llm-provider'
   AND config_key IN (
     'defaultProvider', 'defaultModel', 'baseUrl',
     'openaiModel', 'openaiApiBase', 'deepseekModel', 'deepseekApiBase',
     'xiaomiModel', 'xiaomiApiBase', 'anthropicModel', 'anthropicApiBase',
     'dashscopeModel', 'dashscopeApiBase'
   );
