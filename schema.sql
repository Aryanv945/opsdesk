-- OpsDesk schema. Timestamps are integer milliseconds since epoch (UTC).
-- Every table is created idempotently so `migrate()` can run on every boot.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id   INTEGER PRIMARY KEY,
  key  TEXT NOT NULL UNIQUE,           -- short code used in item keys, e.g. PAY
  name TEXT NOT NULL
);

-- A user can belong to many teams with a different role in each.
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  role    TEXT NOT NULL CHECK (role IN ('viewer','member','lead')),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id, role);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,         -- sha256 of the cookie value; raw token never stored
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id                INTEGER PRIMARY KEY,
  team_id           INTEGER NOT NULL REFERENCES teams(id),
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  type              TEXT NOT NULL CHECK (type IN ('incident','customer_issue','engineering','payment','compliance','task')),
  priority          INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4),   -- 1 = most urgent
  status            TEXT NOT NULL CHECK (status IN ('open','in_progress','blocked','awaiting_approval','resolved','closed')),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approved_by       INTEGER REFERENCES users(id),
  approved_at       INTEGER,
  assignee_id       INTEGER REFERENCES users(id),
  reporter_id       INTEGER NOT NULL REFERENCES users(id),
  due_at            INTEGER,
  resolution        TEXT,
  version           INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency token
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,             -- last change to the item's fields
  last_activity_at  INTEGER NOT NULL              -- last change OR comment
);
-- Indexes are shaped around the list/attention queries (team scope first, then filter, then sort key).
CREATE INDEX IF NOT EXISTS idx_items_team_updated  ON work_items(team_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_team_status   ON work_items(team_id, status, priority, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_assignee      ON work_items(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_items_status_due    ON work_items(status, due_at);
CREATE INDEX IF NOT EXISTS idx_items_updated       ON work_items(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_priority      ON work_items(priority, updated_at DESC, id DESC);
-- Partial indexes for the most common question: "active work, most urgent first".
-- The list query writes the active-status predicate literally so SQLite can prove these apply.
CREATE INDEX IF NOT EXISTS idx_items_active_priority ON work_items(priority, updated_at DESC, id DESC)
  WHERE status IN ('open','in_progress','blocked','awaiting_approval');
CREATE INDEX IF NOT EXISTS idx_items_active_team_priority ON work_items(team_id, priority, updated_at DESC, id DESC)
  WHERE status IN ('open','in_progress','blocked','awaiting_approval');

-- Full-text search over title + description, kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS work_items_fts USING fts5(
  title, description, content='work_items', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS work_items_ai AFTER INSERT ON work_items BEGIN
  INSERT INTO work_items_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;
CREATE TRIGGER IF NOT EXISTS work_items_ad AFTER DELETE ON work_items BEGIN
  INSERT INTO work_items_fts(work_items_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
END;
CREATE TRIGGER IF NOT EXISTS work_items_au AFTER UPDATE OF title, description ON work_items BEGIN
  INSERT INTO work_items_fts(work_items_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
  INSERT INTO work_items_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES work_items(id),
  author_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id, id);

-- Append-only audit log. Never updated or deleted by the application.
-- It is the source for the item timeline, live updates (SSE) and notifications.
CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES work_items(id),
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  actor_id   INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,          -- created | updated | claimed | assigned | released | transitioned | commented
  data       TEXT NOT NULL DEFAULT '{}',
  version    INTEGER,                -- item version after this change (NULL for comments)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_item ON activity(item_id, id DESC);

-- Transactional outbox. Rows are written in the same transaction as the change that caused them.
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  run_after    INTEGER NOT NULL,
  locked_until INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, run_after);

-- UNIQUE(user_id, activity_id) makes notification delivery idempotent:
-- a job that runs twice cannot notify the same person twice about the same event.
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  item_id     INTEGER NOT NULL REFERENCES work_items(id),
  activity_id INTEGER NOT NULL REFERENCES activity(id),
  message     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER,
  UNIQUE (user_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);

-- Stored results of mutating requests, keyed by (user, Idempotency-Key).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id      INTEGER NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
