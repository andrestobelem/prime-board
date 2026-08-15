-- Relaciones entre issues (AT-175): una fila por relación, leída desde ambos extremos.
-- Dirección canónica: issue_id → related_id ('blocks': issue_id bloquea a related_id;
-- 'duplicate_of': issue_id duplica a related_id; 'related': simétrica, se guarda una vez).
CREATE TABLE issue_relations (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  related_id TEXT NOT NULL REFERENCES issues(id),
  type TEXT NOT NULL CHECK (type IN ('blocks', 'related', 'duplicate_of')),
  created_at TEXT NOT NULL,
  UNIQUE (issue_id, related_id, type),
  CHECK (issue_id != related_id)
);

CREATE INDEX idx_issue_relations_related ON issue_relations (related_id);
