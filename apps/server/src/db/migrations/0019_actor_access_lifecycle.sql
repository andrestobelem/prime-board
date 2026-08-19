-- PRB-379: ciclo de acceso del roster e invitaciones locales.
-- La identidad de los actores y sus referencias históricas se conservan; el estado
-- solo impide autenticación/operaciones nuevas.
ALTER TABLE actors ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended', 'left'));
ALTER TABLE actors ADD COLUMN suspended_at TEXT;
ALTER TABLE actors ADD COLUMN suspended_by TEXT REFERENCES actors(id);
ALTER TABLE actors ADD COLUMN left_at TEXT;
CREATE INDEX idx_actors_status ON actors(status);

-- Invitaciones locales: no requieren OAuth ni un proveedor externo. La única copia
-- del token se entrega al admin al crearla; en la DB se conserva solo su hash.
CREATE TABLE actor_invitations (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  type TEXT CHECK (type IN ('human', 'agent')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by TEXT NOT NULL REFERENCES actors(id),
  actor_id TEXT REFERENCES actors(id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_actor_invitations_status ON actor_invitations(status, created_at);
CREATE INDEX idx_actor_invitations_actor ON actor_invitations(actor_id);
CREATE UNIQUE INDEX idx_actor_invitations_pending_email
  ON actor_invitations(lower(email)) WHERE status = 'pending' AND email IS NOT NULL;

-- Revocar una key conserva su identidad y la trazabilidad de la key sin permitir
-- que vuelva a autenticarse.
ALTER TABLE api_keys ADD COLUMN revoked_at TEXT;
CREATE INDEX idx_api_keys_actor_revoked ON api_keys(actor_id, revoked_at);
