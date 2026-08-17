-- PRB-264: cada webhook pertenece al actor que lo creó; admin conserva bypass.
ALTER TABLE webhooks ADD COLUMN owner_id TEXT REFERENCES actors(id);

-- Webhooks existentes se atribuyen al actor admin para no dejarlos huérfanos.
UPDATE webhooks
SET owner_id = (
  SELECT id FROM actors
  WHERE workspace_role = 'admin'
  ORDER BY created_at, id
  LIMIT 1
)
WHERE owner_id IS NULL;

CREATE INDEX idx_webhooks_owner ON webhooks(owner_id);
