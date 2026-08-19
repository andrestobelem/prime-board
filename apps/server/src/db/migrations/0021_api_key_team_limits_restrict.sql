-- PRB-380: una allowlist no puede desaparecer al borrar su Team.
-- Rebuild de la tabla para corregir bases que ya aplicaron 0020 con CASCADE.
CREATE TABLE api_key_team_limits_restricted (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  PRIMARY KEY (api_key_id, team_id)
);
INSERT INTO api_key_team_limits_restricted (api_key_id, team_id)
SELECT api_key_id, team_id FROM api_key_team_limits;
DROP TABLE api_key_team_limits;
ALTER TABLE api_key_team_limits_restricted RENAME TO api_key_team_limits;
CREATE INDEX idx_api_key_team_limits_team ON api_key_team_limits(team_id);
