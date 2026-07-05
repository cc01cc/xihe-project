ALTER TABLE files
    DROP COLUMN IF EXISTS session_id CASCADE,
    DROP COLUMN IF EXISTS message_id CASCADE;

ALTER TABLE messages
    DROP COLUMN IF EXISTS attachments;

DROP INDEX IF EXISTS idx_files_session_id;
DROP INDEX IF EXISTS idx_files_message_id;
