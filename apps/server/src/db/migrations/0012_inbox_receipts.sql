-- PRB-210: estado de lectura/archivo del inbox por actor.
CREATE TABLE inbox_receipts (
  activity_id TEXT NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  read_at TEXT,
  archived_at TEXT,
  PRIMARY KEY (activity_id, actor_id)
);
CREATE INDEX idx_inbox_receipts_actor ON inbox_receipts(actor_id);
