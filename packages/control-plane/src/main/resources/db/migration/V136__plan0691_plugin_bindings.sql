-- PLAN-0691 T1.2 (V136): plugin bindings + per-session frozen snapshots.
--
-- Authority: spec/data-plane.md DP-6/SEC-2, spec/openapi-delta.md §1 routes 8–16, design.md D-65 ②③.
--
-- D-65 ② (hard requirement, not an application-level check): every binding points at one
-- installed plugin *version row* through the composite FK (plugin_id, digest) → plugins(id, digest)
-- with ON DELETE RESTRICT. The registry may therefore keep several versions side by side, while a
-- version that is still bound can never be deleted behind the binding's back — the uninstall path
-- has to fail (409) and be told to detach explicitly instead of silently dropping rows.
--
-- DP-6: the binding is the only join between a workspace and a plugin. session_plugin_bindings
-- references the binding (never workspace_id/user_id — those live on the binding), so a snapshot
-- cannot smuggle a second ownership axis in. Both child keys cascade: an explicit binding delete
-- removes its snapshots, and a session delete removes its own attach records.
--
-- SEC-2: binding state is the lowercase five-state machine shared with T2.5
-- (pending → enabled → degraded → suspended → disabled). The DB check is the backstop; the service
-- is the only writer of the transitions.

CREATE TABLE plugin_bindings (
    id            UUID         NOT NULL,
    plugin_id     VARCHAR(128) NOT NULL,
    digest        VARCHAR(80)  NOT NULL,
    -- Denormalised from plugins at bind time. The FK is the authority; this column exists so the
    -- wire view and the session snapshot can be projected without a second read.
    version       VARCHAR(64)  NOT NULL,
    workspace_id  UUID         NOT NULL,
    -- Bindings are workspace-scoped by construction (spec/authz-plugin-atoms.md: plugin:bind scope
    -- is workspace). The column is kept explicit so a future instance-scope never has to be guessed
    -- from a null.
    scope_type    VARCHAR(16)  NOT NULL DEFAULT 'workspace',
    state         VARCHAR(16)  NOT NULL DEFAULT 'pending',
    -- Granted atoms are stored as a JSON array of atom strings: the manifest itself is jsonb and the
    -- effective set is recomputed by T1.3, so a normalised grant table is deliberately NOT created
    -- here (T1.3 owns plugin_binding_grants + the intersection).
    granted_atoms JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- Where the granted set came from, in the S5 vocabulary: 'default' = builtin workspace default
    -- set, 'plugin_binding' = explicit grant on this binding. Mirrors GrantSources.PLUGIN_BINDING.
    grant_source  VARCHAR(32)  NOT NULL DEFAULT 'plugin_binding',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_plugin_bindings PRIMARY KEY (id),
    CONSTRAINT fk_plugin_bindings_workspace
        FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_plugin_bindings_plugin
        FOREIGN KEY (plugin_id, digest) REFERENCES plugins (id, digest) ON DELETE RESTRICT,
    CONSTRAINT ck_plugin_bindings_scope_type
        CHECK (scope_type IN ('workspace')),
    CONSTRAINT ck_plugin_bindings_state
        CHECK (state IN ('pending', 'enabled', 'degraded', 'suspended', 'disabled')),
    CONSTRAINT ck_plugin_bindings_grant_source
        CHECK (grant_source IN ('default', 'plugin_binding')),
    CONSTRAINT ck_plugin_bindings_granted_atoms_array
        CHECK (jsonb_typeof(granted_atoms) = 'array'),
    -- spec/openapi-delta.md §4 PLUGIN_CONFLICT: one binding per (workspace, plugin). Unconditional
    -- (not partial): deleting the binding row frees the slot again, because uninstall deletes
    -- bindings explicitly (SEC-2) and never leaves a soft-deleted placeholder behind.
    CONSTRAINT uq_plugin_bindings_workspace_plugin UNIQUE (workspace_id, plugin_id)
);

CREATE INDEX idx_plugin_bindings_plugin ON plugin_bindings (plugin_id, digest);
CREATE INDEX idx_plugin_bindings_workspace_state ON plugin_bindings (workspace_id, state);

-- One row per (session, binding): attach sets it, detach stamps detached_at and keeps the snapshot
-- (a run that was admitted with the plugin keeps its evidence). Re-attach revives the same row and
-- bumps revision, so "which snapshot did this turn see" stays answerable.
CREATE TABLE session_plugin_bindings (
    session_id  UUID        NOT NULL,
    binding_id  UUID        NOT NULL,
    -- Frozen projection as of attach time: {bindingId, pluginId, version, digest, state}. jsonb (not
    -- a set of columns) because the in-flight run must see *exactly* what was attached even if the
    -- binding later changes state or the plugin upgrades.
    snapshot    JSONB       NOT NULL,
    revision    INTEGER     NOT NULL DEFAULT 1,
    attached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    detached_at TIMESTAMPTZ,
    CONSTRAINT pk_session_plugin_bindings PRIMARY KEY (session_id, binding_id),
    CONSTRAINT fk_session_plugin_bindings_session
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_session_plugin_bindings_binding
        FOREIGN KEY (binding_id) REFERENCES plugin_bindings (id) ON DELETE CASCADE,
    CONSTRAINT ck_session_plugin_bindings_revision CHECK (revision >= 1),
    CONSTRAINT ck_session_plugin_bindings_snapshot_object
        CHECK (jsonb_typeof(snapshot) = 'object'),
    CONSTRAINT ck_session_plugin_bindings_detach_order
        CHECK (detached_at IS NULL OR detached_at >= attached_at)
);

CREATE INDEX idx_session_plugin_bindings_binding ON session_plugin_bindings (binding_id);
CREATE INDEX idx_session_plugin_bindings_active
    ON session_plugin_bindings (session_id) WHERE detached_at IS NULL;
