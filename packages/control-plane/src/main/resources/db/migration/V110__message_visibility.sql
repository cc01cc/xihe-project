-- PLAN-0630 M5b / D3: internal (non-user-facing) Messages.
--
-- The wake pipeline hands the woken agent an instruction through the Run's user Message
-- (`WakeDispatchService` builds "[mention wake …] respond to the conversation." and
-- `SessionWakeupService` persists it through the normal submission path). That is the model
-- input by design, but until now it also rendered in the conversation stream, because a
-- Message had no notion of "not for the user".
--
-- `visibility` is the explicit channel instead of an implicit convention on `content`
-- (marker prefixes / regex sniffing were rejected: they are unenforceable and leak into
-- every read path). Existing rows are user-facing, hence the NOT NULL default.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS visibility varchar(16) NOT NULL DEFAULT 'user';

ALTER TABLE messages
    ADD CONSTRAINT ck_messages_visibility CHECK (visibility IN ('user', 'internal'));
