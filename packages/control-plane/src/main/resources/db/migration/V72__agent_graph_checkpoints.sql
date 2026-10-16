-- PLAN-0510 M0/M1 (V69): CP-owned LangGraph checkpoint storage.
-- The Agent only receives an opaque CP service API; it never opens this schema.

CREATE TABLE agent_graph_checkpoint_lineages (
    lineage_id       UUID PRIMARY KEY,
    thread_id        UUID NOT NULL,
    session_id       UUID NOT NULL,
    user_id          UUID NOT NULL,
    workspace_id     UUID NOT NULL,
    branch_id        UUID NOT NULL,
    source_run_id    UUID,
    probe_id         UUID,
    producer_version VARCHAR(64) NOT NULL,
    schema_version   SMALLINT NOT NULL DEFAULT 1,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_agent_graph_checkpoint_lineage_thread UNIQUE (thread_id),
    CONSTRAINT uq_agent_graph_checkpoint_lineage_scope UNIQUE (lineage_id, thread_id),
    CONSTRAINT ck_agent_graph_checkpoint_schema_version CHECK (schema_version > 0),
    CONSTRAINT ck_agent_graph_checkpoint_lineage_identity CHECK (
        (source_run_id IS NOT NULL AND probe_id IS NULL)
        OR (source_run_id IS NULL AND probe_id IS NOT NULL)
    ),
    CONSTRAINT fk_agent_graph_checkpoint_lineage_session
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    -- Branch ownership is validated on every CP read/write. Deferred NO ACTION
    -- permits Session deletion to cascade both lineage and branch in one txn.
    CONSTRAINT fk_agent_graph_checkpoint_lineage_branch
        FOREIGN KEY (session_id, branch_id) REFERENCES session_branches (session_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_agent_graph_checkpoint_lineages_session
    ON agent_graph_checkpoint_lineages (session_id, created_at);
CREATE UNIQUE INDEX uq_agent_graph_checkpoint_lineage_source_run
    ON agent_graph_checkpoint_lineages (session_id, source_run_id)
    WHERE source_run_id IS NOT NULL;
CREATE UNIQUE INDEX uq_agent_graph_checkpoint_lineage_probe
    ON agent_graph_checkpoint_lineages (session_id, probe_id)
    WHERE probe_id IS NOT NULL;

CREATE TABLE agent_graph_checkpoints (
    checkpoint_row_id  UUID NOT NULL DEFAULT gen_random_uuid(),
    lineage_id          UUID NOT NULL,
    thread_id           UUID NOT NULL,
    checkpoint_ns       VARCHAR(256) NOT NULL DEFAULT '',
    checkpoint_id       VARCHAR(128) NOT NULL,
    parent_checkpoint_id VARCHAR(128),
    payload_type        VARCHAR(64) NOT NULL,
    checkpoint_blob     BYTEA NOT NULL,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_agent_graph_checkpoints
        PRIMARY KEY (checkpoint_row_id),
    CONSTRAINT uq_agent_graph_checkpoints_saver_key
        UNIQUE (thread_id, checkpoint_ns, checkpoint_id),
    CONSTRAINT uq_agent_graph_checkpoint_lineage_key
        UNIQUE (lineage_id, thread_id, checkpoint_ns, checkpoint_id),
    CONSTRAINT fk_agent_graph_checkpoint_lineage
        FOREIGN KEY (lineage_id, thread_id)
        REFERENCES agent_graph_checkpoint_lineages (lineage_id, thread_id) ON DELETE CASCADE,
    CONSTRAINT fk_agent_graph_checkpoint_parent
        FOREIGN KEY (thread_id, checkpoint_ns, parent_checkpoint_id)
        REFERENCES agent_graph_checkpoints (thread_id, checkpoint_ns, checkpoint_id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_agent_graph_checkpoints_lineage_order
    ON agent_graph_checkpoints (lineage_id, checkpoint_ns, created_at, checkpoint_id);

CREATE TABLE agent_graph_checkpoint_writes (
    write_row_id    UUID NOT NULL DEFAULT gen_random_uuid(),
    lineage_id       UUID NOT NULL,
    thread_id        UUID NOT NULL,
    checkpoint_ns    VARCHAR(256) NOT NULL DEFAULT '',
    checkpoint_id    VARCHAR(128) NOT NULL,
    task_id          VARCHAR(256) NOT NULL,
    task_path        VARCHAR(1024) NOT NULL DEFAULT '',
    write_index      INTEGER NOT NULL,
    channel          VARCHAR(256) NOT NULL,
    payload_type     VARCHAR(64) NOT NULL,
    value_blob       BYTEA NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_agent_graph_checkpoint_writes
        PRIMARY KEY (write_row_id),
    CONSTRAINT uq_agent_graph_checkpoint_writes_saver_key
        UNIQUE (thread_id, checkpoint_ns, checkpoint_id, task_id, write_index),
    CONSTRAINT fk_agent_graph_checkpoint_write_checkpoint
        FOREIGN KEY (lineage_id, thread_id, checkpoint_ns, checkpoint_id)
        REFERENCES agent_graph_checkpoints (lineage_id, thread_id, checkpoint_ns, checkpoint_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_agent_graph_checkpoint_writes_lineage
    ON agent_graph_checkpoint_writes (lineage_id, thread_id, checkpoint_ns, checkpoint_id);
