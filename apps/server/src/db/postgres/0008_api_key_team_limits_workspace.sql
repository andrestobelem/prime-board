-- PRB-552: conserva el alcance de Workspace de cada límite de Team.
-- La migración 0007 creó el grant de la key, pero el baseline PostgreSQL
-- todavía almacenaba los límites sin Workspace. En una instalación anterior
-- al soporte multi-Workspace, el backfill es determinista: usa el único
-- Workspace permitido por la restricción de 0002.

DO $$
DECLARE
  workspace_count INTEGER;
BEGIN
  SELECT count(*) INTO workspace_count FROM workspace;
  IF workspace_count <> 1 AND EXISTS (SELECT 1 FROM api_key_team_limits) THEN
    RAISE EXCEPTION
      'Cannot backfill API key Team limits without one unambiguous Workspace';
  END IF;
END;
$$;

ALTER TABLE api_key_team_limits ADD COLUMN workspace_id TEXT;

UPDATE api_key_team_limits
SET workspace_id = (
  SELECT id FROM workspace ORDER BY created_at, id LIMIT 1
)
WHERE workspace_id IS NULL;

ALTER TABLE api_key_team_limits
  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE api_key_team_limits
  ADD CONSTRAINT api_key_team_limits_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
CREATE INDEX idx_api_key_team_limits_workspace
  ON api_key_team_limits(workspace_id, team_id, api_key_id);
