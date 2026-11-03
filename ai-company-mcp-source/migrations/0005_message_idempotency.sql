-- Existing messages remain unkeyed; SQLite permits multiple NULLs in a unique index.
ALTER TABLE message_feed ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX message_feed_sender_idempotency ON message_feed(sender, idempotency_key);
