-- PRB-513: la autenticación PostgreSQL usa grants y Memberships de Workspace.
-- Conserva la identidad global del Actor por compatibilidad. La autenticación
-- debe leer el rol y el estado de la Membership efectiva.

CREATE TABLE workspace_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'left')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  suspended_at TEXT,
  suspended_by TEXT REFERENCES actors(id),
  left_at TEXT,
  UNIQUE (workspace_id, actor_id)
);
CREATE INDEX idx_workspace_memberships_actor_workspace
  ON workspace_memberships(actor_id, workspace_id);
CREATE INDEX idx_workspace_memberships_workspace_status_role
  ON workspace_memberships(workspace_id, status, role);

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

-- Las instalaciones PostgreSQL existentes tienen un Workspace. Conserva su
-- identidad y acceso sin cambiar los hashes de API keys.
INSERT INTO workspace_memberships (
  id, workspace_id, actor_id, role, status, created_at, updated_at,
  suspended_at, suspended_by, left_at
)
SELECT workspace.id || ':' || actors.id,
       workspace.id,
       actors.id,
       actors.workspace_role,
       actors.status,
       actors.created_at,
       actors.updated_at,
       actors.suspended_at,
       actors.suspended_by,
       actors.left_at
FROM workspace CROSS JOIN actors
WHERE NOT EXISTS (
  SELECT 1
  FROM workspace_memberships memberships
  WHERE memberships.workspace_id = workspace.id
    AND memberships.actor_id = actors.id
);

INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
SELECT api_keys.id, workspace.id, 1, api_keys.created_at
FROM api_keys CROSS JOIN workspace
WHERE NOT EXISTS (
  SELECT 1
  FROM api_key_workspaces grants
  WHERE grants.api_key_id = api_keys.id
    AND grants.workspace_id = workspace.id
);

-- Los nuevos Actors y keys reciben las filas iniciales del Workspace. El
-- lifecycle permanece separado: sus cambios deben actualizar la Membership.
CREATE OR REPLACE FUNCTION prime_board_seed_workspace_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO workspace_memberships (
    id, workspace_id, actor_id, role, status, created_at, updated_at,
    suspended_at, suspended_by, left_at
  )
  SELECT workspace.id || ':' || NEW.id,
         workspace.id,
         NEW.id,
         NEW.workspace_role,
         NEW.status,
         NEW.created_at,
         NEW.updated_at,
         NEW.suspended_at,
         NEW.suspended_by,
         NEW.left_at
  FROM workspace
  WHERE NOT EXISTS (
    SELECT 1
    FROM workspace_memberships memberships
    WHERE memberships.workspace_id = workspace.id
      AND memberships.actor_id = NEW.id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER prime_board_actor_workspace_membership_insert
AFTER INSERT ON actors
FOR EACH ROW
EXECUTE FUNCTION prime_board_seed_workspace_membership();

CREATE OR REPLACE FUNCTION prime_board_seed_api_key_workspace_grant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
  SELECT NEW.id, workspace.id, 1, NEW.created_at
  FROM workspace
  WHERE NOT EXISTS (
    SELECT 1
    FROM api_key_workspaces grants
    WHERE grants.api_key_id = NEW.id
      AND grants.workspace_id = workspace.id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER prime_board_api_key_workspace_grant_insert
AFTER INSERT ON api_keys
FOR EACH ROW
EXECUTE FUNCTION prime_board_seed_api_key_workspace_grant();
