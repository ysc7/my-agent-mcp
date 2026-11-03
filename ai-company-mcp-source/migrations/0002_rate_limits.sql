-- One bounded row per authenticated identity; existing application tables are untouched.
CREATE TABLE IF NOT EXISTS rate_limits (
  identity TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0)
);
