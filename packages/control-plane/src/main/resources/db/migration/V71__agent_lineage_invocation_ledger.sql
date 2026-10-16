-- PLAN-0510 T1.3 (V71): durable CP-side deduplication for mutation tool calls that
-- may be replayed when a LangGraph continuation starts from an older checkpoint.
-- Never persist request arguments or MCP result bodies here. The SHA-256
-- argument fingerprint is internal comparison data only.
--
-- Rollback: DROP TABLE agent_lineage_invocations;

CREATE TABLE agent_lineage_invocations (
    id                         UUID PRIMARY KEY,
    lineage_id                 UUID         NOT NULL,
    originating_tool_call_id   VARCHAR(128) NOT NULL,
    first_run_id               UUID         NOT NULL,
    first_tool_call_id         UUID         NOT NULL,
    mcp_invocation_id          UUID,
    tool_name                  VARCHAR(128) NOT NULL,
    arguments_hash             VARCHAR(64)  NOT NULL,
    status                     VARCHAR(24)  NOT NULL,
    conflict_count             INTEGER      NOT NULL DEFAULT 0,
    last_conflict_code         VARCHAR(48),
    last_conflict_at           TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_agent_lineage_invocation_lineage
        FOREIGN KEY (lineage_id)
        REFERENCES agent_graph_checkpoint_lineages (lineage_id) ON DELETE CASCADE,
    CONSTRAINT fk_agent_lineage_invocation_mcp
        FOREIGN KEY (mcp_invocation_id)
        REFERENCES mcp_invocations (id) ON DELETE SET NULL,
    CONSTRAINT uq_agent_lineage_invocation_origin
        UNIQUE (lineage_id, originating_tool_call_id),
    CONSTRAINT ck_agent_lineage_invocation_origin
        CHECK (length(btrim(originating_tool_call_id)) > 0
               AND length(originating_tool_call_id) <= 128),
    CONSTRAINT ck_agent_lineage_invocation_tool
        CHECK (length(btrim(tool_name)) > 0),
    CONSTRAINT ck_agent_lineage_invocation_hash
        CHECK (arguments_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_agent_lineage_invocation_status
        CHECK (status IN ('pending', 'completed', 'ambiguous', 'unknown', 'failed')),
    CONSTRAINT ck_agent_lineage_invocation_conflicts
        CHECK (conflict_count >= 0)
);

CREATE INDEX idx_agent_lineage_invocation_lineage_status
    ON agent_lineage_invocations (lineage_id, status, created_at);
