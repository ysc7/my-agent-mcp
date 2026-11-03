CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
  sender TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_created_at ON messages(created_at DESC, id DESC);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 4000),
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'completed')),
  claimed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'pending' AND claimed_by IS NULL) OR (status IN ('claimed', 'completed') AND claimed_by IS NOT NULL))
);
CREATE INDEX tasks_created_at ON tasks(created_at DESC, id DESC);
