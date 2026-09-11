-- =============================================================================
-- V13 — PLAN-0307: 旧域键清理（决策 #39：不搬移，直接清理）
-- =============================================================================
-- 背景：V12 完成层（instance/user/workspace）与 MCP 载体迁移；旧域键不再被
--   任何消费方读取（域重组见 config-schemas/ 与 T2.1），按无兼容期原则删除。
--
-- 删除目标：
--   ① 非八域 domain 行（infrastructure / workspace-config / mcp 等）
--   ② logging 域非现行键（instructions/userName/useRegistry/useSupervisor/
--      workersDir/logDir/auditConsole/runtimeFilter …）
--   ③ llm-provider 域非现行键（contextPolicy、全部 *ApiKey；凭证归
--      provider_connections / env 兜底）
--   ④ user-preference 域非现行键（defaultModel/maxTokens/temperature 归 llm-provider）
--
-- 幂等：无匹配即 0 行；重复执行不产生额外变更。
-- 不触碰：config_audit 历史行（审计保留）、八域合法键。
-- 回滚：数据不可逆；如需回滚仅能从迁移前 pg_dump 备份恢复。
-- =============================================================================

-- ① 裁撤域整体删除
DELETE FROM config
 WHERE domain NOT IN (
     'llm-provider', 'context-policy', 'embedding', 'rag',
     'agent-runtime', 'agent-profile', 'user-preference', 'logging'
 );

-- ② logging：仅保留五级日志键
DELETE FROM config
 WHERE domain = 'logging'
   AND config_key NOT IN ('logLevel', 'levelAgent', 'levelCp', 'levelRuntime', 'levelUi');

-- ③ llm-provider：仅保留现行连接/模型/参数键
DELETE FROM config
 WHERE domain = 'llm-provider'
   AND config_key NOT IN (
     'defaultProvider', 'defaultModel', 'baseUrl', 'imageProvider',
     'maxTokens', 'temperature', 'timeout',
     'openaiModel', 'openaiApiBase', 'deepseekModel', 'deepseekApiBase',
     'xiaomiModel', 'xiaomiApiBase', 'anthropicModel', 'anthropicApiBase',
     'dashscopeModel', 'dashscopeApiBase'
   );

-- ④ user-preference：仅保留界面偏好键
DELETE FROM config
 WHERE domain = 'user-preference'
   AND config_key NOT IN ('theme', 'language');
