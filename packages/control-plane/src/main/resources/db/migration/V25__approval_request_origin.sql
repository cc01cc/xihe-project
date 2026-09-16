-- =============================================================================
-- V25 — PLAN-0337：审批行 durable 来源标识（origin）
-- =============================================================================
-- 目的：审批行此前有两条创建路径——CP 闸门判定（McpProxyController 的 ASK 分支经
--   recordGatePending）与 Agent 中继（模型主动调用 request_approval，经 ChatController
--   的 recordPending）。两者在 AgentService 的同一入口收敛，落出的 durable 行**同构**，
--   事后无法从库中区分来源，只能翻日志（approval_required 在 audit.log、
--   chat_approval_gate_pending 在 cp.log）。本迁移补一列记录来源，使审计/统计/护栏断言
--   都能用单一 DB 口径。
--
-- 取值：'cp_gate'（CP 闸门判定后创建）、'agent_relay'（Agent 中继的模型显式提问）。
--   NULL = 本列引入前创建的历史行（不猜测、不回填——历史来源不可靠，宁可标为未知）。
--
-- 回滚：ALTER TABLE approval_requests DROP CONSTRAINT ck_approval_requests_origin;
--       ALTER TABLE approval_requests DROP COLUMN origin;
-- =============================================================================

ALTER TABLE approval_requests
    ADD COLUMN origin VARCHAR(16);

ALTER TABLE approval_requests
    ADD CONSTRAINT ck_approval_requests_origin
        CHECK (origin IS NULL OR origin IN ('cp_gate', 'agent_relay'));

COMMENT ON COLUMN approval_requests.origin IS
    'PLAN-0337: creation provenance — cp_gate = CP policy gate asked for approval, agent_relay = model explicitly requested approval; NULL = legacy row predating this column';
