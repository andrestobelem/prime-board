-- PRB-473: grants de API keys y alcance de límites por Team.
-- Los grants separan la identidad global de una key del Workspace que autoriza.
-- Las columnas siguen siendo nullable durante la transición para que el backfill
-- pueda validar una instalación con varios Workspaces sin inventar una relación.

CREATE TABLE api_key_workspaces (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (api_key_id, workspace_id)
);
CREATE INDEX idx_api_key_workspaces_workspace
  ON api_key_workspaces(workspace_id, api_key_id);
CREATE UNIQUE INDEX idx_api_key_workspaces_default
  ON api_key_workspaces(api_key_id) WHERE is_default = 1;

ALTER TABLE api_key_team_limits ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;

-- Un único Workspace legacy es la única asignación segura para límites y keys.
UPDATE api_key_team_limits
SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1)
WHERE workspace_id IS NULL;

CREATE INDEX idx_api_key_team_limits_workspace
  ON api_key_team_limits(workspace_id, team_id);

-- Las escrituras legacy siguen funcionando mientras solo hay un Workspace. Los
-- callers multi-Workspace deberán enviar el Workspace explícito en PRB-413.
CREATE TRIGGER api_key_team_limits_workspace_scope_insert
AFTER INSERT ON api_key_team_limits
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE api_key_team_limits SET workspace_id = (SELECT id FROM workspace)
  WHERE api_key_id = NEW.api_key_id AND team_id = NEW.team_id;
END;

CREATE TRIGGER api_keys_workspace_grant_insert
AFTER INSERT ON api_keys
WHEN (SELECT count(*) FROM workspace) = 1
BEGIN
  INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
  SELECT NEW.id, workspace.id, 1, NEW.created_at
  FROM workspace
  WHERE NOT EXISTS (
    SELECT 1 FROM api_key_workspaces
    WHERE api_key_id = NEW.id AND workspace_id = workspace.id
  );
END;

-- Backfill sin tocar la identidad ni el hash secreto de ninguna key.
INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
SELECT api_keys.id, workspace.id, 1, api_keys.created_at
FROM api_keys CROSS JOIN workspace
WHERE (SELECT count(*) FROM workspace) = 1
  AND NOT EXISTS (
    SELECT 1 FROM api_key_workspaces
    WHERE api_key_id = api_keys.id AND workspace_id = workspace.id
  );
