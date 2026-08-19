-- PRB-380: scopes, límites por Team, expiración y rotación de API keys.
-- Las credenciales y sus metadatos operativos permanecen fuera de la réplica.
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
ALTER TABLE api_keys ADD COLUMN rotated_from_id TEXT REFERENCES api_keys(id);

CREATE TABLE api_key_scopes (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write', 'admin')),
  PRIMARY KEY (api_key_id, scope)
);

CREATE TABLE api_key_team_limits (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  PRIMARY KEY (api_key_id, team_id)
);

-- Las keys preexistentes conservan su capacidad efectiva anterior.
INSERT INTO api_key_scopes (api_key_id, scope)
SELECT id, 'read' FROM api_keys;
INSERT INTO api_key_scopes (api_key_id, scope)
SELECT id, 'write' FROM api_keys;
INSERT INTO api_key_scopes (api_key_id, scope)
SELECT id, 'admin' FROM api_keys;

CREATE INDEX idx_api_key_scopes_scope ON api_key_scopes(scope);
CREATE INDEX idx_api_key_team_limits_team ON api_key_team_limits(team_id);
