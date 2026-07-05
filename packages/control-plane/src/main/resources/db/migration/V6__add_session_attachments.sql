ALTER TABLE files
    ADD COLUMN session_id VARCHAR(36) REFERENCES sessions(id) ON DELETE CASCADE,
    ADD COLUMN message_id VARCHAR(36) REFERENCES messages(id) ON DELETE SET NULL;

ALTER TABLE messages
    ADD COLUMN attachments JSONB;

CREATE INDEX idx_files_session_id ON files(session_id);
CREATE INDEX idx_files_message_id ON files(message_id);
