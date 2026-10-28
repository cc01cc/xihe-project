-- PLAN-0565 ruling #7: add username to users (required, unique, letter-first).
-- Format: ^[a-z][a-z0-9]{0,31}$ — lowercase letters and digits only, must start
-- with a letter. Existing rows are backfilled from the email local part:
-- lowercase, non-alphanumerics stripped, truncated to 32; an empty or
-- digit-leading result gets the "user" prefix; duplicates get numeric suffixes
-- (assignment order: created_at, then id — deterministic and collision-free).

ALTER TABLE users ADD COLUMN username VARCHAR(32);

-- Unique index first so the backfill probe is indexed; NULLs are still distinct
-- until every row is assigned below.
CREATE UNIQUE INDEX uq_users_username ON users (username);

DO $$
DECLARE
    r RECORD;
    candidate TEXT;
    n INT;
BEGIN
    FOR r IN SELECT id,
                    left(CASE
                             WHEN cleaned = '' OR cleaned !~ '^[a-z]' THEN 'user' || cleaned
                             ELSE cleaned
                        END, 32) AS base
             FROM (
                 SELECT id, created_at,
                        regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9]', '', 'g') AS cleaned
                 FROM users
             ) c
             ORDER BY created_at, id
    LOOP
        n := 1;
        candidate := r.base;
        WHILE EXISTS (SELECT 1 FROM users WHERE username = candidate AND id <> r.id) LOOP
            n := n + 1;
            candidate := left(r.base, 32 - length(n::text)) || n::text;
        END LOOP;
        UPDATE users SET username = candidate WHERE id = r.id;
    END LOOP;
END $$;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
