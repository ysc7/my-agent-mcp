-- Preserve legacy broadcasts, assigning each a durable monotonic cursor.
CREATE TABLE message_feed (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO message_feed (id, content, sender, recipient, created_at)
  SELECT id, content, sender, NULL, created_at FROM messages ORDER BY created_at, rowid;
CREATE INDEX message_feed_recipient_seq ON message_feed(recipient, seq);
