-- PLAN-0439: an unbound Session is explicit; no data reset occurs in a migration.
ALTER TABLE sessions
    ALTER COLUMN context_template_layer DROP NOT NULL,
    ALTER COLUMN context_template_layer DROP DEFAULT,
    ALTER COLUMN context_template_id DROP NOT NULL,
    ALTER COLUMN context_template_id DROP DEFAULT,
    ALTER COLUMN context_template_version DROP NOT NULL,
    ALTER COLUMN context_template_version DROP DEFAULT,
    ADD CONSTRAINT ck_sessions_context_template_tuple CHECK (
        (context_template_layer IS NULL AND context_template_id IS NULL AND context_template_version IS NULL)
        OR (context_template_layer IS NOT NULL AND context_template_id IS NOT NULL AND context_template_version IS NOT NULL)
    );
