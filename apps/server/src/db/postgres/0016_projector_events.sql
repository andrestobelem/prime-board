-- Eventos aplicados por stream (PRB-599).
-- Conserva la deduplicación necesaria para backfills fuera de orden.
CREATE TABLE IF NOT EXISTS projector_events (
  stream TEXT NOT NULL,
  event_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stream, event_id)
);
