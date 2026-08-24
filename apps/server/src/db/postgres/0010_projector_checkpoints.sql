-- Checkpoint durable del projector (PRB-445).
-- El checkpoint no contiene datos de dominio: solo permite reanudar un stream.
CREATE TABLE IF NOT EXISTS projector_checkpoints (
  stream TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
