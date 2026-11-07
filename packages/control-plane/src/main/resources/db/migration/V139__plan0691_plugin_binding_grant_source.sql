-- PLAN-0691 T1.3: `plugin_binding` becomes a grant source the product may write.
--
-- Why: PluginBindingAuthorization gates every binding write on the PLUGIN_BIND atom, but until now
-- only roles could issue that atom, so a binding-scoped hold had no issuer — the gate was installed
-- and permanently answered by the caller's role. PluginBindingGrantWriter now issues one
-- source='plugin_binding' row per binding (scope = workspace, granter = the binding, as provenance),
-- and V88's allow-list rejects it. Hence this widening.
--
-- Widening only: the five existing values stay valid (no row is rewritten, no backfill — D-215), and
-- the constraint stays in place, so an unknown source is still a 23514 rather than silently inert
-- data. The old `default`/`direct` values remain excluded exactly as V88 left them; they are not
-- evaluation sources (GrantSources.EVALUATION_SOURCES) and must not come back through this file.
--
-- Consumer contract: GrantSources.WRITABLE_SOURCES lists the same six values in code; the two lists
-- are compared element-wise by PluginBindingGrantSourceMigrationTest, so editing one side alone fails
-- a real PostgreSQL test.

ALTER TABLE grants DROP CONSTRAINT ck_grants_source;
ALTER TABLE grants ADD CONSTRAINT ck_grants_source
    CHECK (source IN ('role', 'spawn', 'template', 'credential_binding', 'agent_default',
                      'plugin_binding'));
